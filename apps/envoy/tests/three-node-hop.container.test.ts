import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
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

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const repoRoot = path.resolve(__dirname, '../../..')

/** Fixed Envoy listener port — one route per test, one port per node. */
const ENVOY_LISTENER_PORT = 10000

/** Timeout for Docker setup (builds, image pulls, container starts). */
const SETUP_TIMEOUT = 600_000 // 10 minutes

/** Timeout for individual test cases. */
const TEST_TIMEOUT = 60_000 // 60 seconds

// ---------------------------------------------------------------------------
// Docker image names — use three-node-e2e tag to avoid collision
// ---------------------------------------------------------------------------

const ORCH_IMAGE = 'catalyst-orchestrator:three-node-e2e'
const ENVOY_SVC_IMAGE = 'catalyst-envoy:three-node-e2e'
const ENVOY_PROXY_IMAGE = 'catalyst-envoy-proxy:three-node-e2e'
const AUTH_IMAGE = 'catalyst-auth:three-node-e2e'
const BOOKS_IMAGE = 'books-service:three-node-e2e'

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
  console.warn('Skipping three-node hop container tests: Docker not running')
}

// ---------------------------------------------------------------------------
// Image builder with caching
// ---------------------------------------------------------------------------

async function buildImageIfNeeded(imageName: string, dockerfile: string): Promise<void> {
  const check = Bun.spawnSync([CONTAINER_RUNTIME, 'image', 'inspect', imageName])
  if (check.exitCode === 0) {
    console.log(`Using existing image: ${imageName}`)
    return
  }
  console.log(`Building image: ${imageName}...`)
  const build = Bun.spawn([CONTAINER_RUNTIME, 'build', '-f', dockerfile, '-t', imageName, '.'], {
    cwd: repoRoot,
    stdout: 'ignore',
    stderr: 'inherit',
  })
  const exitCode = await build.exited
  if (exitCode !== 0) throw new Error(`Failed to build ${imageName}`)
}

// ---------------------------------------------------------------------------
// Bootstrap YAML generator
// ---------------------------------------------------------------------------

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
// Three-node cluster setup helper
// ---------------------------------------------------------------------------

interface ThreeNodeCluster {
  network: StartedNetwork
  auth: AuthServiceContext
  booksContainer: StartedTestContainer
  envoySvcA: StartedTestContainer
  envoySvcB: StartedTestContainer
  envoySvcC: StartedTestContainer
  envoyProxyA: StartedTestContainer
  envoyProxyB: StartedTestContainer
  envoyProxyC: StartedTestContainer
  orchA: StartedTestContainer
  orchB: StartedTestContainer
  orchC: StartedTestContainer
  envoyAAdminPort: number
  envoyBAdminPort: number
  envoyCAdminPort: number
  systemToken: string
}

/**
 * Sets up a 3-node cluster with the given protocol for the books-api route.
 *
 * Architecture (11 containers):
 * - Auth (:5000), books-api (:8080)
 * - Node A: orch-a, envoy-svc-a, envoy-proxy-a  (origin — has the route)
 * - Node B: orch-b, envoy-svc-b, envoy-proxy-b  (transit relay)
 * - Node C: orch-c, envoy-svc-c, envoy-proxy-c  (consumer — sends traffic)
 *
 * Peering: A <-> B, B <-> C (linear chain, B is transit)
 * Traffic: C -> B -> A -> books-api
 */
async function setupThreeNodeCluster(protocol: string): Promise<ThreeNodeCluster> {
  // ── 1. Build images ────────────────────────────────────────────
  await buildImageIfNeeded(AUTH_IMAGE, 'apps/auth/Dockerfile')
  await buildImageIfNeeded(ORCH_IMAGE, 'apps/orchestrator/Dockerfile')
  await buildImageIfNeeded(ENVOY_SVC_IMAGE, 'apps/envoy/Dockerfile')
  await buildImageIfNeeded(ENVOY_PROXY_IMAGE, 'apps/envoy/Dockerfile.envoy-proxy')
  await buildImageIfNeeded(BOOKS_IMAGE, 'examples/books-api/Dockerfile')

  // ── 2. Docker network ──────────────────────────────────────────
  const network = await new Network().start()

  // ── 3. Auth service ────────────────────────────────────────────
  const auth = await startAuthService(network, 'auth', AUTH_IMAGE)
  const systemToken = auth.systemToken

  // ── 4. Books API ───────────────────────────────────────────────
  console.log('[setup] Starting books-api container...')
  const booksContainer = await new GenericContainer(BOOKS_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('books')
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/health', 8080))
    .withLogConsumer(withLogConsumer('books'))
    .start()

  // ── 5. Envoy Services (A, B, C) ───────────────────────────────
  const startEnvoySvc = async (id: string, alias: string): Promise<StartedTestContainer> => {
    console.log(`[setup] Starting ${alias}...`)
    return new GenericContainer(ENVOY_SVC_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(alias)
      .withExposedPorts(3000, 18000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: alias,
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_ENVOY_XDS_PORT: '18000',
        CATALYST_ENVOY_BIND_ADDRESS: '0.0.0.0',
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [envoy] listening'))
      .withLogConsumer(withLogConsumer(alias))
      .start()
  }

  const envoySvcA = await startEnvoySvc('a', 'envoy-svc-a')
  const envoySvcB = await startEnvoySvc('b', 'envoy-svc-b')
  const envoySvcC = await startEnvoySvc('c', 'envoy-svc-c')

  // ── 6. Envoy Proxies (A, B, C) ────────────────────────────────
  const startEnvoyProxy = async (alias: string, xdsHost: string): Promise<StartedTestContainer> => {
    console.log(`[setup] Starting ${alias}...`)
    const bootstrap = generateBootstrapYaml(xdsHost, 18000)
    return new GenericContainer(ENVOY_PROXY_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(alias)
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withCopyContentToContainer([{ content: bootstrap, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .withLogConsumer(withLogConsumer(alias))
      .start()
  }

  const envoyProxyA = await startEnvoyProxy('envoy-proxy-a', 'envoy-svc-a')
  const envoyProxyB = await startEnvoyProxy('envoy-proxy-b', 'envoy-svc-b')
  const envoyProxyC = await startEnvoyProxy('envoy-proxy-c', 'envoy-svc-c')

  const envoyAAdminPort = envoyProxyA.getMappedPort(9901)
  const envoyBAdminPort = envoyProxyB.getMappedPort(9901)
  const envoyCAdminPort = envoyProxyC.getMappedPort(9901)

  // Brief wait for ADS streams to establish
  await new Promise((r) => setTimeout(r, 1000))

  // ── 7. Orchestrators (A, B, C) ─────────────────────────────────
  const startOrchestrator = async (
    alias: string,
    nodeId: string,
    envoySvcAlias: string,
    envoyProxyAlias: string
  ): Promise<StartedTestContainer> => {
    console.log(`[setup] Starting ${alias}...`)
    return new GenericContainer(ORCH_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(alias)
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: nodeId,
        CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: auth.endpoint,
        CATALYST_SYSTEM_TOKEN: systemToken,
        CATALYST_ENVOY_ENDPOINT: `ws://${envoySvcAlias}:3000/api`,
        CATALYST_ENVOY_PORT_RANGE: `[${ENVOY_LISTENER_PORT}]`,
        CATALYST_ENVOY_ADDRESS: envoyProxyAlias,
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
      .withLogConsumer(withLogConsumer(alias))
      .start()
  }

  const orchA = await startOrchestrator(
    'orch-a',
    'node-a.somebiz.local.io',
    'envoy-svc-a',
    'envoy-proxy-a'
  )
  const orchB = await startOrchestrator(
    'orch-b',
    'node-b.somebiz.local.io',
    'envoy-svc-b',
    'envoy-proxy-b'
  )
  const orchC = await startOrchestrator(
    'orch-c',
    'node-c.somebiz.local.io',
    'envoy-svc-c',
    'envoy-proxy-c'
  )

  console.log('[setup] All 11 containers started.')

  // ── 8. Peer orchestrators: A <-> B, B <-> C ────────────────────
  console.log('[setup] Peering nodes: A <-> B, B <-> C...')
  const clientA = getOrchestratorClient(orchA)
  const clientB = getOrchestratorClient(orchB)
  const clientC = getOrchestratorClient(orchC)

  const netAResult = await clientA.getNetworkClient(systemToken)
  const netBResult = await clientB.getNetworkClient(systemToken)
  const netCResult = await clientC.getNetworkClient(systemToken)
  if (!netAResult.success) throw new Error(`Auth failed on orch-a: ${netAResult.error}`)
  if (!netBResult.success) throw new Error(`Auth failed on orch-b: ${netBResult.error}`)
  if (!netCResult.success) throw new Error(`Auth failed on orch-c: ${netCResult.error}`)

  const netA = (netAResult as { success: true; client: NetworkClient }).client
  const netB = (netBResult as { success: true; client: NetworkClient }).client
  const netC = (netCResult as { success: true; client: NetworkClient }).client

  // Peer A <-> B: B accepts A, then A connects to B
  await netB.addPeer({
    name: 'node-a.somebiz.local.io',
    endpoint: 'ws://orch-a:3000/rpc',
    domains: ['somebiz.local.io'],
    peerToken: systemToken,
  })
  await netA.addPeer({
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://orch-b:3000/rpc',
    domains: ['somebiz.local.io'],
    peerToken: systemToken,
  })

  // Peer B <-> C: C accepts B, then B connects to C
  await netC.addPeer({
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://orch-b:3000/rpc',
    domains: ['somebiz.local.io'],
    peerToken: systemToken,
  })
  await netB.addPeer({
    name: 'node-c.somebiz.local.io',
    endpoint: 'ws://orch-c:3000/rpc',
    domains: ['somebiz.local.io'],
    peerToken: systemToken,
  })

  // Brief wait for BGP handshake before polling
  await new Promise((r) => setTimeout(r, 1000))

  // Wait for BGP peering to establish
  console.log('[setup] Waiting for BGP peering handshakes...')
  await waitForPeerConnected(clientA, systemToken, 'node-b.somebiz.local.io')
  await waitForPeerConnected(clientB, systemToken, 'node-a.somebiz.local.io')
  await waitForPeerConnected(clientB, systemToken, 'node-c.somebiz.local.io')
  await waitForPeerConnected(clientC, systemToken, 'node-b.somebiz.local.io')
  console.log('[setup] BGP peering established: A <-> B <-> C')

  // ── 9. Create books-api route on Node A ────────────────────────
  console.log(`[setup] Creating books-api route on Node A (protocol: ${protocol})...`)
  const dataAResult = await clientA.getDataChannelClient(systemToken)
  if (!dataAResult.success) throw new Error('Failed to get data client A')

  const routeResult = await dataAResult.client.addRoute({
    name: 'books-api',
    protocol,
    endpoint: 'http://books:8080/graphql',
  })
  if (!routeResult.success) {
    throw new Error(`Failed to create route: ${routeResult.error || 'Unknown error'}`)
  }

  // ── 10. Wait for xDS propagation across all 3 nodes ────────────
  // Node A: ingress listener for books-api
  console.log('[setup] Waiting for Envoy A ingress listener...')
  await waitForListener(envoyAAdminPort, 'ingress_books-api', 60_000)
  console.log('[setup] Envoy A ready — ingress listener active.')

  // Node B: egress listener for books-api via node-a (B receives from A)
  console.log('[setup] Waiting for Envoy B egress listener...')
  await waitForListener(envoyBAdminPort, 'egress_books-api_via_node-a.somebiz.local.io', 60_000)
  console.log('[setup] Envoy B ready — egress listener active.')

  // Node C: egress listener for books-api via node-b (C receives from B)
  console.log('[setup] Waiting for Envoy C egress listener...')
  await waitForListener(envoyCAdminPort, 'egress_books-api_via_node-b.somebiz.local.io', 60_000)
  console.log('[setup] Envoy C ready — egress listener active.')

  console.log('[setup] Three-node cluster setup complete.')

  return {
    network,
    auth,
    booksContainer,
    envoySvcA,
    envoySvcB,
    envoySvcC,
    envoyProxyA,
    envoyProxyB,
    envoyProxyC,
    orchA,
    orchB,
    orchC,
    envoyAAdminPort,
    envoyBAdminPort,
    envoyCAdminPort,
    systemToken,
  }
}

async function teardownCluster(cluster: ThreeNodeCluster): Promise<void> {
  console.log('[teardown] Stopping containers...')
  // Stop in reverse order of dependency
  await cluster.orchC?.stop().catch(() => {})
  await cluster.orchB?.stop().catch(() => {})
  await cluster.orchA?.stop().catch(() => {})
  await cluster.envoyProxyC?.stop().catch(() => {})
  await cluster.envoyProxyB?.stop().catch(() => {})
  await cluster.envoyProxyA?.stop().catch(() => {})
  await cluster.envoySvcC?.stop().catch(() => {})
  await cluster.envoySvcB?.stop().catch(() => {})
  await cluster.envoySvcA?.stop().catch(() => {})
  await cluster.booksContainer?.stop().catch(() => {})
  await cluster.auth?.container.stop().catch(() => {})
  await cluster.network?.stop().catch(() => {})
  console.log('[teardown] Done.')
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

/**
 * HTTP Three-Node Multi-Hop E2E test.
 *
 * Route protocol: `http:graphql` — Envoy uses HCM (HTTP Connection Manager)
 * listeners at each hop.
 *
 * Traffic path: C -> B -> A -> books-api
 */
describe.skipIf(skipTests)('HTTP Three-Node Multi-Hop', () => {
  let cluster: ThreeNodeCluster

  beforeAll(async () => {
    cluster = await setupThreeNodeCluster('http:graphql')
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    if (cluster) await teardownCluster(cluster)
  }, SETUP_TIMEOUT)

  it(
    'propagates route from Node A through Node B to Node C',
    async () => {
      // Node A: ingress listener + local cluster
      const listenersA = await fetch(
        `http://localhost:${cluster.envoyAAdminPort}/listeners?format=json`
      )
      const listenersAText = await listenersA.text()
      expect(listenersAText).toContain('ingress_books-api')

      const clustersA = await fetch(
        `http://localhost:${cluster.envoyAAdminPort}/clusters?format=json`
      )
      const clustersAText = await clustersA.text()
      expect(clustersAText).toContain('local_books-api')

      // Node B: egress listener + remote cluster (via node-a)
      const listenersB = await fetch(
        `http://localhost:${cluster.envoyBAdminPort}/listeners?format=json`
      )
      const listenersBText = await listenersB.text()
      expect(listenersBText).toContain('egress_books-api_via_node-a.somebiz.local.io')

      const clustersB = await fetch(
        `http://localhost:${cluster.envoyBAdminPort}/clusters?format=json`
      )
      const clustersBText = await clustersB.text()
      expect(clustersBText).toContain('remote_books-api_via_node-a.somebiz.local.io')

      // Node C: egress listener + remote cluster (via node-b)
      const listenersC = await fetch(
        `http://localhost:${cluster.envoyCAdminPort}/listeners?format=json`
      )
      const listenersCText = await listenersC.text()
      expect(listenersCText).toContain('egress_books-api_via_node-b.somebiz.local.io')

      const clustersC = await fetch(
        `http://localhost:${cluster.envoyCAdminPort}/clusters?format=json`
      )
      const clustersCText = await clustersC.text()
      expect(clustersCText).toContain('remote_books-api_via_node-b.somebiz.local.io')
    },
    TEST_TIMEOUT
  )

  it(
    'routes GraphQL traffic C -> B -> A -> books-api via HTTP',
    async () => {
      // curl from inside Envoy C container to hit the egress port
      // Path: curl (inside Envoy C) -> egress :10000 -> envoy-proxy-b:10000 -> envoy-proxy-a:10000 -> books:8080
      const proc = Bun.spawn(
        [
          CONTAINER_RUNTIME,
          'exec',
          cluster.envoyProxyC.getId(),
          'curl',
          '-s',
          '-X',
          'POST',
          '-H',
          'Content-Type: application/json',
          '-d',
          '{"query":"{ books { title author } }"}',
          `http://127.0.0.1:${ENVOY_LISTENER_PORT}/graphql`,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()

      expect(exitCode).toBe(0)

      const json = JSON.parse(stdout.trim()) as {
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
})

/**
 * TCP Three-Node Multi-Hop E2E test.
 *
 * Route protocol: `tcp` — Envoy uses tcp_proxy (L4 passthrough) listeners at
 * each hop. Since tcp_proxy forwards raw bytes, we can still send HTTP/GraphQL
 * requests through the TCP tunnel.
 *
 * Traffic path: C -> B -> A -> books-api
 */
describe.skipIf(skipTests)('TCP Three-Node Multi-Hop', () => {
  let cluster: ThreeNodeCluster

  beforeAll(async () => {
    cluster = await setupThreeNodeCluster('tcp')
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    if (cluster) await teardownCluster(cluster)
  }, SETUP_TIMEOUT)

  it(
    'propagates route from Node A through Node B to Node C',
    async () => {
      // Node A: ingress listener + local cluster
      const listenersA = await fetch(
        `http://localhost:${cluster.envoyAAdminPort}/listeners?format=json`
      )
      const listenersAText = await listenersA.text()
      expect(listenersAText).toContain('ingress_books-api')

      const clustersA = await fetch(
        `http://localhost:${cluster.envoyAAdminPort}/clusters?format=json`
      )
      const clustersAText = await clustersA.text()
      expect(clustersAText).toContain('local_books-api')

      // Node B: egress listener + remote cluster (via node-a)
      const listenersB = await fetch(
        `http://localhost:${cluster.envoyBAdminPort}/listeners?format=json`
      )
      const listenersBText = await listenersB.text()
      expect(listenersBText).toContain('egress_books-api_via_node-a.somebiz.local.io')

      const clustersB = await fetch(
        `http://localhost:${cluster.envoyBAdminPort}/clusters?format=json`
      )
      const clustersBText = await clustersB.text()
      expect(clustersBText).toContain('remote_books-api_via_node-a.somebiz.local.io')

      // Node C: egress listener + remote cluster (via node-b)
      const listenersC = await fetch(
        `http://localhost:${cluster.envoyCAdminPort}/listeners?format=json`
      )
      const listenersCText = await listenersC.text()
      expect(listenersCText).toContain('egress_books-api_via_node-b.somebiz.local.io')

      const clustersC = await fetch(
        `http://localhost:${cluster.envoyCAdminPort}/clusters?format=json`
      )
      const clustersCText = await clustersC.text()
      expect(clustersCText).toContain('remote_books-api_via_node-b.somebiz.local.io')
    },
    TEST_TIMEOUT
  )

  it(
    'routes GraphQL traffic C -> B -> A -> books-api via TCP passthrough',
    async () => {
      // Same curl command as HTTP — tcp_proxy does L4 passthrough of raw HTTP bytes
      // Path: curl (inside Envoy C) -> tcp egress :10000 -> envoy-proxy-b:10000 -> envoy-proxy-a:10000 -> books:8080
      const proc = Bun.spawn(
        [
          CONTAINER_RUNTIME,
          'exec',
          cluster.envoyProxyC.getId(),
          'curl',
          '-s',
          '-X',
          'POST',
          '-H',
          'Content-Type: application/json',
          '-d',
          '{"query":"{ books { title author } }"}',
          `http://127.0.0.1:${ENVOY_LISTENER_PORT}/graphql`,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()

      expect(exitCode).toBe(0)

      const json = JSON.parse(stdout.trim()) as {
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
})
