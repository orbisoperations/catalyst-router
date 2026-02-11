import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import { spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import path from 'path'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import type { PublicApi, NetworkClient } from '../../orchestrator/src/orchestrator.js'
import {
  startAuthService,
  type AuthServiceContext,
} from '../../orchestrator/tests/auth-test-helpers.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../../..')

/** Fixed Envoy listener port — used for both ingress (Node A) and egress (Node B). */
const ENVOY_LISTENER_PORT = 10000

/** Timeout for Docker setup (builds, image pulls, container starts). */
const SETUP_TIMEOUT = 600_000 // 10 minutes

/** Timeout for individual test cases. */
const TEST_TIMEOUT = 60_000 // 60 seconds

// ---------------------------------------------------------------------------
// Docker image names
// ---------------------------------------------------------------------------

const ORCH_IMAGE = 'catalyst-orchestrator:cross-node-e2e'
const ENVOY_SVC_IMAGE = 'catalyst-envoy:cross-node-e2e'
const AUTH_IMAGE = 'catalyst-auth:cross-node-e2e'
const BOOKS_IMAGE = 'books-service:cross-node-e2e'

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

const isDockerRunning = (): boolean => {
  try {
    return Bun.spawnSync(['docker', 'info']).exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping cross-node routing container tests: Docker not running')
}

// ---------------------------------------------------------------------------
// Image builder with caching
// ---------------------------------------------------------------------------

function buildImageIfNeeded(imageName: string, dockerfile: string): void {
  const check = spawnSync('docker', ['image', 'inspect', imageName])
  if (check.status === 0) {
    console.log(`Using existing image: ${imageName}`)
    return
  }
  console.log(`Building image: ${imageName}...`)
  const result = spawnSync('docker', ['build', '-f', dockerfile, '-t', imageName, '.'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`Failed to build ${imageName}`)
}

// ---------------------------------------------------------------------------
// Bootstrap YAML generator
// ---------------------------------------------------------------------------

/**
 * Generate an Envoy bootstrap config.
 *
 * The xDS cluster uses `STRICT_DNS` with `V4_ONLY` because the xDS server
 * is referenced by Docker network alias (a hostname, not an IP).
 * HTTP/2 is required for gRPC ADS.
 */
function generateBootstrapYaml(xdsHost: string, xdsPort: number): string {
  return `
admin:
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 9901

node:
  id: catalyst-envoy-proxy
  cluster: catalyst

dynamic_resources:
  lds_config:
    resource_api_version: V3
    ads: {}
  cds_config:
    resource_api_version: V3
    ads: {}
  ads_config:
    api_type: GRPC
    transport_api_version: V3
    grpc_services:
      - envoy_grpc:
          cluster_name: xds_cluster

static_resources:
  clusters:
    - name: xds_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          '@type': type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options: {}
      load_assignment:
        cluster_name: xds_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: ${xdsHost}
                      port_value: ${xdsPort}
`.trim()
}

// ---------------------------------------------------------------------------
// Envoy admin readiness pollers
// ---------------------------------------------------------------------------

async function waitForListener(
  adminPort: number,
  listenerName: string,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${adminPort}/listeners?format=json`)
      const text = await res.text()
      if (text.includes(listenerName)) return
    } catch {
      /* Envoy not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for listener ${listenerName} after ${timeoutMs}ms`)
}

async function waitForListenerRemoval(
  adminPort: number,
  listenerName: string,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${adminPort}/listeners?format=json`)
      const text = await res.text()
      if (!text.includes(listenerName)) return
    } catch {
      /* Envoy might be restarting */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for listener ${listenerName} removal after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

function getOrchestratorClient(container: StartedTestContainer): RpcStub<PublicApi> {
  const port = container.getMappedPort(3000)
  return newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${port}/rpc`)
}

async function waitForPeerConnected(
  client: RpcStub<PublicApi>,
  token: string,
  peerName: string,
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const netResult = await client.getNetworkClient(token)
    if (!netResult.success) throw new Error('Failed to get network client')
    const peers = await (netResult as { success: true; client: NetworkClient }).client.listPeers()
    const peer = peers.find((p) => p.name === peerName)
    if (peer && peer.connectionStatus === 'connected') return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Peer ${peerName} failed to connect within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Log consumer helper
// ---------------------------------------------------------------------------

function withLogConsumer(label: string) {
  return (stream: Readable) => {
    stream.on('data', (chunk: Buffer | string) => {
      process.stdout.write(`[${label}] ${chunk.toString()}`)
    })
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * Cross-node routing E2E test — all containers.
 *
 * Architecture (8 containers + 2 Envoy proxy containers):
 * ```
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │                        Docker Network                                 │
 * │                                                                       │
 * │  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌─────────────┐ │
 * │  │  auth    │  │  books-api   │  │ envoy-svc-a   │  │ envoy-svc-b │ │
 * │  │  :5000   │  │  :8080       │  │ :3000 (RPC)   │  │ :3000 (RPC) │ │
 * │  └──────────┘  └──────────────┘  │ :18000 (xDS)  │  │ :18000(xDS) │ │
 * │       ↑               ↑          └───────┬───────┘  └──────┬──────┘ │
 * │       │               │                  │                  │        │
 * │  ┌────┴───────┐  ┌────┴──────────┐  ┌───┴────────┐  ┌─────┴──────┐ │
 * │  │  orch-a    │  │ envoy-proxy-a │  │envoy-prx-a │  │envoy-prx-b │ │
 * │  │  :3000     │  │ :10000 (LDS)  │  │ ADS→svc-a  │  │ ADS→svc-b  │ │
 * │  │  auth→auth │  │ :9901 (admin) │  └────────────┘  └────────────┘ │
 * │  │  envoy→    │  └───────────────┘                                  │
 * │  │   svc-a    │                                                     │
 * │  └────────────┘  ┌───────────────┐  ┌───────────────────────────┐   │
 * │                  │  orch-b       │  │ envoy-proxy-b             │   │
 * │                  │  :3000        │  │ :10000 (egress→envoy-a)   │   │
 * │                  │  auth→auth    │  │ :9901 (admin)             │   │
 * │                  │  envoy→svc-b  │  └───────────────────────────┘   │
 * │                  └───────────────┘                                  │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Host (Bun test process):
 *   - Builds Docker images
 *   - Connects to orch-a / orch-b via mapped ports (capnweb RPC)
 *   - Peers orchestrators, creates routes
 *   - Verifies xDS resources via Envoy admin APIs
 *   - Runs traffic test via container.exec() inside envoy-proxy-b
 * ```
 *
 * Data path:
 *   curl (inside Envoy B) → 127.0.0.1:10000 (egress) → envoy-proxy-a:10000 (ingress) → books:8080
 */
describe.skipIf(skipTests)('Cross-Node Routing: All-Container E2E with Real Envoy Proxies', () => {
  // Docker resources
  let network: StartedNetwork
  let auth: AuthServiceContext
  let booksContainer: StartedTestContainer
  let envoySvcA: StartedTestContainer
  let envoySvcB: StartedTestContainer
  let envoyProxyA: StartedTestContainer
  let envoyProxyB: StartedTestContainer
  let orchA: StartedTestContainer
  let orchB: StartedTestContainer

  // Mapped ports for admin API assertions
  let envoyAAdminPort: number
  let envoyBAdminPort: number

  // RPC auth token
  let systemToken: string

  beforeAll(async () => {
    // ── 1. Build images ────────────────────────────────────────────
    buildImageIfNeeded(AUTH_IMAGE, 'apps/auth/Dockerfile')
    buildImageIfNeeded(ORCH_IMAGE, 'apps/orchestrator/Dockerfile')
    buildImageIfNeeded(ENVOY_SVC_IMAGE, 'apps/envoy/Dockerfile')
    buildImageIfNeeded(BOOKS_IMAGE, 'examples/books-api/Dockerfile')

    // ── 2. Docker network ──────────────────────────────────────────
    network = await new Network().start()

    // ── 3. Auth service ────────────────────────────────────────────
    auth = await startAuthService(network, 'auth', AUTH_IMAGE)
    systemToken = auth.systemToken

    // ── 4. Books API ───────────────────────────────────────────────
    console.log('[setup] Starting books-api container...')
    booksContainer = await new GenericContainer(BOOKS_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('books')
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/health', 8080))
      .withLogConsumer(withLogConsumer('books'))
      .start()

    // ── 5. Envoy Service A ─────────────────────────────────────────
    console.log('[setup] Starting envoy-svc-a...')
    envoySvcA = await new GenericContainer(ENVOY_SVC_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('envoy-svc-a')
      .withExposedPorts(3000, 18000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: 'envoy-svc-a',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_ENVOY_XDS_PORT: '18000',
        CATALYST_ENVOY_BIND_ADDRESS: '0.0.0.0',
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [envoy] listening'))
      .withLogConsumer(withLogConsumer('envoy-svc-a'))
      .start()

    // ── 6. Envoy Service B ─────────────────────────────────────────
    console.log('[setup] Starting envoy-svc-b...')
    envoySvcB = await new GenericContainer(ENVOY_SVC_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('envoy-svc-b')
      .withExposedPorts(3000, 18000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: 'envoy-svc-b',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_ENVOY_XDS_PORT: '18000',
        CATALYST_ENVOY_BIND_ADDRESS: '0.0.0.0',
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [envoy] listening'))
      .withLogConsumer(withLogConsumer('envoy-svc-b'))
      .start()

    // ── 7. Envoy Proxy A (ADS → envoy-svc-a:18000) ────────────────
    console.log('[setup] Starting envoy-proxy-a...')
    const bootstrapA = generateBootstrapYaml('envoy-svc-a', 18000)
    envoyProxyA = await new GenericContainer('envoyproxy/envoy:v1.32-latest')
      .withNetwork(network)
      .withNetworkAliases('envoy-proxy-a')
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withCopyContentToContainer([{ content: bootstrapA, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .withLogConsumer(withLogConsumer('envoy-proxy-a'))
      .start()
    envoyAAdminPort = envoyProxyA.getMappedPort(9901)

    // ── 8. Envoy Proxy B (ADS → envoy-svc-b:18000) ────────────────
    console.log('[setup] Starting envoy-proxy-b...')
    const bootstrapB = generateBootstrapYaml('envoy-svc-b', 18000)
    envoyProxyB = await new GenericContainer('envoyproxy/envoy:v1.32-latest')
      .withNetwork(network)
      .withNetworkAliases('envoy-proxy-b')
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withCopyContentToContainer([{ content: bootstrapB, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .withLogConsumer(withLogConsumer('envoy-proxy-b'))
      .start()
    envoyBAdminPort = envoyProxyB.getMappedPort(9901)

    // Brief wait for ADS streams to establish
    await new Promise((r) => setTimeout(r, 1000))

    // ── 9. Orchestrator A ──────────────────────────────────────────
    console.log('[setup] Starting orch-a...')
    orchA = await new GenericContainer(ORCH_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('orch-a')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: 'node-a.somebiz.local.io',
        CATALYST_PEERING_ENDPOINT: 'ws://orch-a:3000/rpc',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: auth.endpoint,
        CATALYST_SYSTEM_TOKEN: systemToken,
        CATALYST_ENVOY_ENDPOINT: 'ws://envoy-svc-a:3000/api',
        CATALYST_ENVOY_PORT_RANGE: `[${ENVOY_LISTENER_PORT}]`,
        CATALYST_ENVOY_ADDRESS: 'envoy-proxy-a',
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
      .withLogConsumer(withLogConsumer('orch-a'))
      .start()

    // ── 10. Orchestrator B ─────────────────────────────────────────
    console.log('[setup] Starting orch-b...')
    orchB = await new GenericContainer(ORCH_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('orch-b')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: 'node-b.somebiz.local.io',
        CATALYST_PEERING_ENDPOINT: 'ws://orch-b:3000/rpc',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: auth.endpoint,
        CATALYST_SYSTEM_TOKEN: systemToken,
        CATALYST_ENVOY_ENDPOINT: 'ws://envoy-svc-b:3000/api',
        CATALYST_ENVOY_PORT_RANGE: `[${ENVOY_LISTENER_PORT}]`,
        CATALYST_ENVOY_ADDRESS: 'envoy-proxy-b',
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
      .withLogConsumer(withLogConsumer('orch-b'))
      .start()

    console.log('[setup] All 8 containers started.')

    // ── 11. Peer the two orchestrators via RPC ─────────────────────
    console.log('[setup] Peering Node A and Node B...')
    const clientA = getOrchestratorClient(orchA)
    const clientB = getOrchestratorClient(orchB)

    const netAResult = await clientA.getNetworkClient(systemToken)
    const netBResult = await clientB.getNetworkClient(systemToken)
    if (!netAResult.success) throw new Error(`Auth failed on orch-a: ${netAResult.error}`)
    if (!netBResult.success) throw new Error(`Auth failed on orch-b: ${netBResult.error}`)

    const netA = (netAResult as { success: true; client: NetworkClient }).client
    const netB = (netBResult as { success: true; client: NetworkClient }).client

    // B accepts A, then A connects to B
    await netB.addPeer({
      name: 'node-a.somebiz.local.io',
      endpoint: 'ws://orch-a:3000/rpc',
      domains: ['somebiz.local.io'],
    })
    await netA.addPeer({
      name: 'node-b.somebiz.local.io',
      endpoint: 'ws://orch-b:3000/rpc',
      domains: ['somebiz.local.io'],
    })

    // Wait for BGP handshake
    console.log('[setup] Waiting for BGP peering handshake...')
    await waitForPeerConnected(clientA, systemToken, 'node-b.somebiz.local.io')
    await waitForPeerConnected(clientB, systemToken, 'node-a.somebiz.local.io')
    console.log('[setup] BGP peering established.')

    // ── 12. Create books-api route on Node A ───────────────────────
    // Endpoint uses Docker DNS alias so Envoy Proxy A can reach books-api.
    console.log('[setup] Creating books-api route on Node A...')
    const dataAResult = await clientA.getDataChannelClient(systemToken)
    if (!dataAResult.success) throw new Error('Failed to get data client A')

    const routeResult = await dataAResult.client.addRoute({
      name: 'books-api',
      protocol: 'http:graphql',
      endpoint: 'http://books:8080/graphql',
    })
    if (!routeResult.success) {
      throw new Error(`Failed to create route: ${routeResult.error || 'Unknown error'}`)
    }

    // ── 13. Wait for xDS propagation ───────────────────────────────
    // Node A: ingress listener for books-api
    console.log('[setup] Waiting for Envoy A ingress listener...')
    await waitForListener(envoyAAdminPort, 'ingress_books-api', 60_000)
    console.log('[setup] Envoy A ready — ingress listener active.')

    // Node B: egress listener for books-api via node-a
    console.log('[setup] Waiting for Envoy B egress listener...')
    await waitForListener(envoyBAdminPort, 'egress_books-api_via_node-a.somebiz.local.io', 60_000)
    console.log('[setup] Envoy B ready — egress listener active.')

    console.log('[setup] Cross-node setup complete.')
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    console.log('[teardown] Stopping containers...')
    // Stop in reverse order of dependency
    await orchB?.stop().catch(() => {})
    await orchA?.stop().catch(() => {})
    await envoyProxyB?.stop().catch(() => {})
    await envoyProxyA?.stop().catch(() => {})
    await envoySvcB?.stop().catch(() => {})
    await envoySvcA?.stop().catch(() => {})
    await booksContainer?.stop().catch(() => {})
    await auth?.container.stop().catch(() => {})
    await network?.stop().catch(() => {})
    console.log('[teardown] Done.')
  }, SETUP_TIMEOUT)

  it(
    'registers route on Node A and propagates to Node B via BGP',
    async () => {
      // Verify Node A's Envoy has ingress listener for books-api
      const listenersA = await fetch(`http://localhost:${envoyAAdminPort}/listeners?format=json`)
      const listenersAText = await listenersA.text()
      expect(listenersAText).toContain('ingress_books-api')

      // Verify Node A's Envoy has local cluster for books-api
      const clustersA = await fetch(`http://localhost:${envoyAAdminPort}/clusters?format=json`)
      const clustersAText = await clustersA.text()
      expect(clustersAText).toContain('local_books-api')

      // Verify Node B's Envoy has egress listener for books-api via node-a
      const listenersB = await fetch(`http://localhost:${envoyBAdminPort}/listeners?format=json`)
      const listenersBText = await listenersB.text()
      expect(listenersBText).toContain('egress_books-api_via_node-a.somebiz.local.io')

      // Verify Node B's Envoy has remote cluster pointing to Envoy A
      const clustersB = await fetch(`http://localhost:${envoyBAdminPort}/clusters?format=json`)
      const clustersBText = await clustersB.text()
      expect(clustersBText).toContain('remote_books-api_via_node-a.somebiz.local.io')
    },
    TEST_TIMEOUT
  )

  it(
    'routes traffic from Node B through Envoy to books-api on Node A',
    async () => {
      // The egress listener binds to 127.0.0.1 inside the container (by design
      // — egress is for local-node consumption). We use `exec` to run curl
      // from inside the Envoy B container to hit the egress port.
      //
      // Path: curl (inside Envoy B) → egress :10000 → envoy-proxy-a:10000 (ingress) → books:8080
      const execResult = await envoyProxyB.exec([
        'curl',
        '-s',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-d',
        '{"query":"{ books { title author } }"}',
        `http://127.0.0.1:${ENVOY_LISTENER_PORT}/graphql`,
      ])

      expect(execResult.exitCode).toBe(0)

      const json = JSON.parse(execResult.stdout.trim()) as {
        data?: { books?: Array<{ title: string; author: string }> }
        errors?: unknown[]
      }

      expect(json.errors).toBeUndefined()
      expect(json.data).toBeDefined()
      expect(json.data!.books).toBeInstanceOf(Array)
      expect(json.data!.books!.length).toBe(3)

      const titles = json.data!.books!.map((b) => b.title)
      expect(titles).toContain('The Lord of the Rings')
      expect(titles).toContain('Pride and Prejudice')
      expect(titles).toContain('The Hobbit')
    },
    TEST_TIMEOUT
  )

  it(
    'route removal on Node A cleans up egress on Node B',
    async () => {
      // Delete the books-api route on Node A via RPC
      const clientA = getOrchestratorClient(orchA)
      const dataAResult = await clientA.getDataChannelClient(systemToken)
      if (!dataAResult.success) throw new Error('Failed to get data client A')

      const deleteResult = await dataAResult.client.removeRoute({
        name: 'books-api',
        protocol: 'http:graphql',
      })
      expect(deleteResult.success).toBe(true)

      // Wait for the egress listener to be removed from Envoy B
      await waitForListenerRemoval(
        envoyBAdminPort,
        'egress_books-api_via_node-a.somebiz.local.io',
        60_000
      )

      // Verify the ingress listener on Node A is also gone
      await waitForListenerRemoval(envoyAAdminPort, 'ingress_books-api', 60_000)

      // Verify Envoy B no longer has the egress listener
      const listenersB = await fetch(`http://localhost:${envoyBAdminPort}/listeners?format=json`)
      const listenersBText = await listenersB.text()
      expect(listenersBText).not.toContain('egress_books-api_via_node-a.somebiz.local.io')

      // Verify Envoy A no longer has the ingress listener
      const listenersA = await fetch(`http://localhost:${envoyAAdminPort}/listeners?format=json`)
      const listenersAText = await listenersA.text()
      expect(listenersAText).not.toContain('ingress_books-api')
    },
    TEST_TIMEOUT
  )
})
