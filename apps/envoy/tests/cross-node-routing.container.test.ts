import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import path from 'path'
import { CatalystConfigSchema } from '@catalyst/config'
import { AuthService } from '@catalyst/authorization'
import { EnvoyService } from '../src/service.js'
import { OrchestratorService } from '../../orchestrator/src/service.js'
import { mintTokenHandler } from '../../cli/src/handlers/auth-token-handlers.js'
import {
  createRouteHandler,
  deleteRouteHandler,
} from '../../cli/src/handlers/node-route-handlers.js'
import { createPeerHandler } from '../../cli/src/handlers/node-peer-handlers.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const repoRoot = path.resolve(__dirname, '../../..')

/**
 * Fixed Envoy listener port — used for both ingress (Node A) and egress (Node B).
 *
 * When Node A allocates ingress port 10000 for books-api, BGP propagates this
 * port to Node B. Node B reuses the same port number for its egress listener
 * (bound to 127.0.0.1:10000) and its remote cluster (pointing to envoy-a:10000).
 */
const ENVOY_LISTENER_PORT = 10000

/** Timeout for Docker setup (builds, image pulls, container starts). */
const SETUP_TIMEOUT = 600_000 // 10 minutes

/** Timeout for individual test cases. */
const TEST_TIMEOUT = 60_000 // 60 seconds

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
// Bootstrap YAML generator
// ---------------------------------------------------------------------------

/**
 * Generate an Envoy bootstrap config for a Docker container.
 *
 * Uses `STRICT_DNS` because `host.docker.internal` is a hostname.
 * `dns_lookup_family: V4_ONLY` avoids IPv6 resolution delays.
 * HTTP/2 is required for the gRPC ADS connection.
 */
function generateBootstrapYaml(xdsPort: number): string {
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
                      address: host.docker.internal
                      port_value: ${xdsPort}
`.trim()
}

// ---------------------------------------------------------------------------
// Envoy readiness poller
// ---------------------------------------------------------------------------

/**
 * Poll the Envoy admin API until a specific dynamic listener appears.
 */
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

/**
 * Poll until a listener is removed from Envoy's admin API.
 */
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
// Test suite
// ---------------------------------------------------------------------------

/**
 * Cross-node routing E2E test with real Envoy proxies.
 *
 * Architecture:
 * ```
 * ┌───────────────────────────────────────────────────────────────────┐
 * │ Host (Bun test process)                                           │
 * │  Auth Service       (:random)                                     │
 * │  Envoy Service A    (:random) + ADS gRPC (:xdsA)                 │
 * │  Envoy Service B    (:random) + ADS gRPC (:xdsB)                 │
 * │  Orchestrator A     (:orchA)  — envoy-a, books-api route          │
 * │  Orchestrator B     (:orchB)  — envoy-b, peers with A             │
 * └────────────────────┬──────────────────────────────────────────────┘
 *                      │ host.docker.internal
 *        ┌─────────────┴─────────────────────────────────────────┐
 *        │                Docker Network                          │
 *   ┌────┴───────┐   ┌───────────────────┐  ┌──────────────────┐│
 *   │ books-api  │   │ Envoy Proxy A     │  │ Envoy Proxy B    ││
 *   │ alias:books│   │ alias:envoy-a     │  │ alias:envoy-b    ││
 *   │ :8080      │←──│ :10000 (ingress)  │  │ :10000 (egress)  ││
 *   └────────────┘   │ :9901  (admin)    │  │ :9901  (admin)   ││
 *                    └───────────────────┘  └──────────────────┘│
 *                             ↑                       │          │
 *                             └───────────────────────┘          │
 *                        Envoy B egress → envoy-a:10000 ingress  │
 *        └───────────────────────────────────────────────────────┘
 * ```
 *
 * Port 10000 serves dual purpose: ingress on Node A (0.0.0.0:10000) and
 * egress on Node B (127.0.0.1:10000). BGP propagates the port number from
 * Node A's local route to Node B's internal route.
 *
 * Data flow:
 *   curl (inside Envoy B) → 127.0.0.1:10000 (egress) → envoy-a:10000 (ingress) → books-api
 */
describe.skipIf(skipTests)('Cross-Node Routing: Two-Node E2E with Real Envoy Proxies', () => {
  // Docker resources
  let network: StartedNetwork
  let booksContainer: StartedTestContainer
  let envoyContainerA: StartedTestContainer
  let envoyContainerB: StartedTestContainer

  // In-process Bun servers
  let authServer: ReturnType<typeof Bun.serve>
  let envoyServerA: ReturnType<typeof Bun.serve>
  let envoyServerB: ReturnType<typeof Bun.serve>
  let orchServerA: ReturnType<typeof Bun.serve>
  let orchServerB: ReturnType<typeof Bun.serve>

  // Catalyst services (for lifecycle management)
  let authService: AuthService
  let envoyServiceA: EnvoyService
  let envoyServiceB: EnvoyService
  let orchServiceA: OrchestratorService
  let orchServiceB: OrchestratorService

  // Tokens
  let systemToken: string
  let cliToken: string

  // Port tracking
  let ports: {
    auth: number
    books: number
    envoyA: number
    envoyB: number
    orchA: number
    orchB: number
    xdsA: number
    xdsB: number
  }

  // Mapped container ports for test assertions
  let envoyAAdminPort: number
  let envoyBAdminPort: number

  beforeAll(async () => {
    // ── 1. Docker network ──────────────────────────────────────────
    network = await new Network().start()

    // ── 2. Build + start books-api container ───────────────────────
    console.log('[setup] Building books-api image...')
    const build = Bun.spawn(
      [
        CONTAINER_RUNTIME,
        'build',
        '-t',
        'books-service:cross-node-test',
        '-f',
        'examples/books-api/Dockerfile',
        '.',
      ],
      { cwd: repoRoot, stdout: 'ignore', stderr: 'inherit' }
    )
    const buildExit = await build.exited
    if (buildExit !== 0) throw new Error('Failed to build books-api image')

    console.log('[setup] Starting books-api container...')
    booksContainer = await new GenericContainer('books-service:cross-node-test')
      .withNetwork(network)
      .withNetworkAliases('books')
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/health', 8080))
      .start()

    // ── 3. Start in-process Auth Service ───────────────────────────
    const authConfig = CatalystConfigSchema.parse({
      node: { name: 'auth-node', domains: ['somebiz.local.io'] },
      auth: { keysDb: ':memory:', tokensDb: ':memory:' },
      port: 0,
    })
    authService = await AuthService.create({ config: authConfig })
    systemToken = authService.systemToken

    const authApp = new Hono()
    authApp.route('/', authService.handler)
    authServer = Bun.serve({ fetch: authApp.fetch, port: 0, websocket })

    // ── 4. Start Envoy Service A (xDS for Node A) ──────────────────
    const tempXdsA = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const xdsPortA = tempXdsA.port
    tempXdsA.stop()

    const envoyConfigA = CatalystConfigSchema.parse({
      node: { name: 'envoy-node-a', domains: ['somebiz.local.io'] },
      envoy: { adminPort: 9901, xdsPort: xdsPortA, bindAddress: '0.0.0.0' },
      port: 0,
    })
    envoyServiceA = await EnvoyService.create({ config: envoyConfigA })

    const envoyAppA = new Hono()
    envoyAppA.route('/', envoyServiceA.handler)
    envoyServerA = Bun.serve({ fetch: envoyAppA.fetch, port: 0, websocket })

    // ── 5. Start Envoy Service B (xDS for Node B) ──────────────────
    const tempXdsB = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const xdsPortB = tempXdsB.port
    tempXdsB.stop()

    const envoyConfigB = CatalystConfigSchema.parse({
      node: { name: 'envoy-node-b', domains: ['somebiz.local.io'] },
      envoy: { adminPort: 9901, xdsPort: xdsPortB, bindAddress: '0.0.0.0' },
      port: 0,
    })
    envoyServiceB = await EnvoyService.create({ config: envoyConfigB })

    const envoyAppB = new Hono()
    envoyAppB.route('/', envoyServiceB.handler)
    envoyServerB = Bun.serve({ fetch: envoyAppB.fetch, port: 0, websocket })

    // ── 6. Start Orchestrator A ────────────────────────────────────
    const tempOrchA = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const orchPortA = tempOrchA.port
    tempOrchA.stop()

    const orchConfigA = CatalystConfigSchema.parse({
      node: {
        name: 'node-a.somebiz.local.io',
        domains: ['somebiz.local.io'],
        endpoint: `ws://localhost:${orchPortA}/rpc`,
      },
      orchestrator: {
        ibgp: { secret: 'test-secret' },
        auth: {
          endpoint: `ws://localhost:${authServer.port}/rpc`,
          systemToken,
        },
        envoyConfig: {
          endpoint: `ws://localhost:${envoyServerA.port}/api`,
          portRange: [[ENVOY_LISTENER_PORT, ENVOY_LISTENER_PORT]],
        },
      },
      port: orchPortA,
    })

    // Add envoyAddress to Node A's config so BGP propagates it to peers.
    // When Node B receives an internal route from A, the peer.envoyAddress
    // tells Node B's envoy where to route egress traffic.
    ;(orchConfigA.node as Record<string, unknown>).envoyAddress = 'envoy-a'

    orchServiceA = await OrchestratorService.create({ config: orchConfigA })

    const orchAppA = new Hono()
    orchAppA.route('/', orchServiceA.handler)
    orchServerA = Bun.serve({ fetch: orchAppA.fetch, port: orchPortA, websocket })

    // ── 7. Start Orchestrator B ────────────────────────────────────
    const tempOrchB = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const orchPortB = tempOrchB.port
    tempOrchB.stop()

    const orchConfigB = CatalystConfigSchema.parse({
      node: {
        name: 'node-b.somebiz.local.io',
        domains: ['somebiz.local.io'],
        endpoint: `ws://localhost:${orchPortB}/rpc`,
      },
      orchestrator: {
        ibgp: { secret: 'test-secret' },
        auth: {
          endpoint: `ws://localhost:${authServer.port}/rpc`,
          systemToken,
        },
        envoyConfig: {
          endpoint: `ws://localhost:${envoyServerB.port}/api`,
          // Node B does not allocate local ingress ports — internal routes
          // arrive with envoyPort already set from BGP. This range exists
          // only to satisfy the schema (min 1 entry).
          portRange: [[10100, 10200]],
        },
      },
      port: orchPortB,
    })

    // Add envoyAddress to Node B's config too (for symmetry, though not
    // needed by this test since we only route from B → A).
    ;(orchConfigB.node as Record<string, unknown>).envoyAddress = 'envoy-b'

    orchServiceB = await OrchestratorService.create({ config: orchConfigB })

    const orchAppB = new Hono()
    orchAppB.route('/', orchServiceB.handler)
    orchServerB = Bun.serve({ fetch: orchAppB.fetch, port: orchPortB, websocket })

    ports = {
      auth: authServer.port,
      books: booksContainer.getMappedPort(8080),
      envoyA: envoyServerA.port,
      envoyB: envoyServerB.port,
      orchA: orchPortA,
      orchB: orchPortB,
      xdsA: xdsPortA,
      xdsB: xdsPortB,
    }

    // ── 8. Mint CLI token ──────────────────────────────────────────
    console.log('[setup] Minting CLI token...')
    const mintResult = await mintTokenHandler({
      subject: 'test-cli',
      principal: 'CATALYST::ADMIN',
      name: 'Test CLI',
      type: 'service',
      authUrl: `ws://localhost:${ports.auth}/rpc`,
      token: systemToken,
    })
    if (!mintResult.success) throw new Error(`Failed to mint CLI token: ${mintResult.error}`)
    cliToken = mintResult.data.token

    // ── 9. Start Envoy Proxy A (connects to Envoy Service A via ADS) ─
    console.log(`[setup] Starting Envoy Proxy A (ADS at host.docker.internal:${xdsPortA})...`)
    const bootstrapA = generateBootstrapYaml(xdsPortA)

    envoyContainerA = await new GenericContainer('envoyproxy/envoy:v1.32-latest')
      .withNetwork(network)
      .withNetworkAliases('envoy-a')
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withCopyContentToContainer([{ content: bootstrapA, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .start()

    envoyAAdminPort = envoyContainerA.getMappedPort(9901)

    // ── 10. Start Envoy Proxy B (connects to Envoy Service B via ADS) ─
    console.log(`[setup] Starting Envoy Proxy B (ADS at host.docker.internal:${xdsPortB})...`)
    const bootstrapB = generateBootstrapYaml(xdsPortB)

    envoyContainerB = await new GenericContainer('envoyproxy/envoy:v1.32-latest')
      .withNetwork(network)
      .withNetworkAliases('envoy-b')
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withCopyContentToContainer([{ content: bootstrapB, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .start()

    envoyBAdminPort = envoyContainerB.getMappedPort(9901)

    // Brief wait for ADS streams to establish on both proxies
    await new Promise((r) => setTimeout(r, 1000))

    // ── 11. Peer the two orchestrators ────────────────────────────
    console.log('[setup] Peering Node A and Node B...')

    const peerAResult = await createPeerHandler({
      name: 'node-b.somebiz.local.io',
      endpoint: `ws://localhost:${ports.orchB}/rpc`,
      domains: ['somebiz.local.io'],
      orchestratorUrl: `ws://localhost:${ports.orchA}/rpc`,
      token: cliToken,
    })
    if (!peerAResult.success) throw new Error(`Failed to peer A→B: ${peerAResult.error}`)

    const peerBResult = await createPeerHandler({
      name: 'node-a.somebiz.local.io',
      endpoint: `ws://localhost:${ports.orchA}/rpc`,
      domains: ['somebiz.local.io'],
      orchestratorUrl: `ws://localhost:${ports.orchB}/rpc`,
      token: cliToken,
    })
    if (!peerBResult.success) throw new Error(`Failed to peer B→A: ${peerBResult.error}`)

    // Wait for BGP handshake
    console.log('[setup] Waiting for BGP peering handshake...')
    await new Promise((r) => setTimeout(r, 3000))

    // ── 12. Create books-api route on Node A ──────────────────────
    // Endpoint uses Docker DNS alias — Envoy A (inside Docker) reaches books-api.
    console.log('[setup] Creating books-api route on Node A...')
    const routeResult = await createRouteHandler({
      name: 'books-api',
      endpoint: 'http://books:8080/graphql',
      protocol: 'http:graphql',
      orchestratorUrl: `ws://localhost:${ports.orchA}/rpc`,
      token: cliToken,
    })
    if (!routeResult.success) throw new Error(`Failed to create route: ${routeResult.error}`)

    // ── 13. Wait for xDS propagation ──────────────────────────────
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
    // 1. Stop Docker containers
    await envoyContainerB?.stop().catch(() => {})
    await envoyContainerA?.stop().catch(() => {})
    await booksContainer?.stop().catch(() => {})
    await network?.stop().catch(() => {})

    // 2. Stop Bun servers
    orchServerB?.stop()
    orchServerA?.stop()
    envoyServerB?.stop()
    envoyServerA?.stop()
    authServer?.stop()

    // 3. Shutdown Catalyst services
    await orchServiceB?.shutdown()
    await orchServiceA?.shutdown()
    await envoyServiceB?.shutdown()
    await envoyServiceA?.shutdown()
    await authService?.shutdown()
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
      // Path: curl (inside Envoy B) → egress :10000 → envoy-a:10000 (ingress) → books-api
      const execResult = await envoyContainerB.exec([
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
      // Delete the books-api route on Node A
      const deleteResult = await deleteRouteHandler({
        name: 'books-api',
        orchestratorUrl: `ws://localhost:${ports.orchA}/rpc`,
        token: cliToken,
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
