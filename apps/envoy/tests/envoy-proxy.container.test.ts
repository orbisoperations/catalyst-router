import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
import { createRouteHandler } from '../../cli/src/handlers/node-route-handlers.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const repoRoot = path.resolve(__dirname, '../../..')

/** Fixed port for the Envoy listener — portRange is [[10000, 10000]]. */
const ENVOY_LISTENER_PORT = 10000

/** Timeout for Docker setup (builds, image pulls, container starts). */
const SETUP_TIMEOUT = 300_000 // 5 minutes

/** Timeout for individual test cases (just HTTP requests). */
const TEST_TIMEOUT = 30_000 // 30 seconds

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
  console.warn('Skipping envoy proxy container tests: Docker not running')
}

// ---------------------------------------------------------------------------
// Bootstrap YAML generator
// ---------------------------------------------------------------------------

/**
 * Generate an Envoy bootstrap config for the Docker container.
 *
 * The xDS cluster uses `STRICT_DNS` because `host.docker.internal` is a
 * hostname, not an IP. `dns_lookup_family: V4_ONLY` avoids IPv6 resolution
 * delays in Docker environments. HTTP/2 is required for the gRPC ADS
 * connection.
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
 *
 * Envoy creates listeners dynamically after receiving LDS from the ADS
 * server. This function polls `/listeners?format=json` until the named
 * listener is present, indicating Envoy is ready to route traffic.
 */
async function waitForListener(
  adminPort: number,
  listenerName: string,
  timeoutMs = 30_000
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
// Test suite
// ---------------------------------------------------------------------------

/**
 * Real Envoy proxy container test — end-to-end traffic routing.
 *
 * Architecture:
 * ```
 * ┌───────────────────────────────────────────────────┐
 * │ Host (Bun test process)                           │
 * │  Auth Service      (:random)                      │
 * │  Envoy Service     (:random) + ADS gRPC (:xds)   │
 * │  Orchestrator      (:random)                      │
 * │  Test client → fetch(localhost:mapped/graphql)     │
 * └────────────────────┬──────────────────────────────┘
 *                      │ host.docker.internal
 *        ┌─────────────┴──────────────┐
 *        │      Docker Network         │
 *   ┌────┴───────┐   ┌──────────────┐ │
 *   │ books-api  │   │ Envoy Proxy  │ │
 *   │ alias:books│   │ ADS→host:xds │ │
 *   │ :8080      │←──│ :10000 (LDS) │ │
 *   └────────────┘   │ :9901 (admin)│ │
 *                     └──────────────┘ │
 *        └────────────────────────────┘
 * ```
 *
 * Data path: CLI → Orchestrator → Envoy Service → ADS gRPC → Envoy Proxy → books-api
 */
describe.skipIf(skipTests)('Envoy Proxy Container: Real Traffic Routing', () => {
  // Docker resources
  let network: StartedNetwork
  let booksContainer: StartedTestContainer
  let envoyContainer: StartedTestContainer

  // In-process Bun servers
  let authServer: ReturnType<typeof Bun.serve>
  let envoyServer: ReturnType<typeof Bun.serve>
  let orchServer: ReturnType<typeof Bun.serve>

  // Catalyst services (for lifecycle management)
  let authService: AuthService
  let envoyService: EnvoyService
  let orchService: OrchestratorService

  // Mapped ports for test assertions
  let envoyMappedPort: number
  let adminMappedPort: number

  beforeAll(async () => {
    // ── 1. Docker network ──────────────────────────────────────────
    network = await new Network().start()

    // ── 2. Build + start books-api container ───────────────────────
    // The Dockerfile uses a deps-caching layer: workspace package.json
    // files are copied first so `bun install` is cached across rebuilds.
    console.log('[setup] Building books-api image...')
    const build = Bun.spawn(
      [
        CONTAINER_RUNTIME,
        'build',
        '-t',
        'books-service:envoy-test',
        '-f',
        'examples/books-api/Dockerfile',
        '.',
      ],
      { cwd: repoRoot, stdout: 'ignore', stderr: 'inherit' }
    )
    const buildExit = await build.exited
    if (buildExit !== 0) throw new Error('Failed to build books-api image')

    console.log('[setup] Starting books-api container...')
    booksContainer = await new GenericContainer('books-service:envoy-test')
      .withNetwork(network)
      .withNetworkAliases('books')
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/health', 8080))
      .start()

    // ── 3. Start in-process Catalyst services ──────────────────────

    // Auth (in-memory, random port)
    const authConfig = CatalystConfigSchema.parse({
      node: { name: 'auth-node', domains: ['somebiz.local.io'] },
      auth: { keysDb: ':memory:', tokensDb: ':memory:' },
      port: 0,
    })
    authService = await AuthService.create({ config: authConfig })
    const systemToken = authService.systemToken

    const authApp = new Hono()
    authApp.route('/', authService.handler)
    authServer = Bun.serve({ fetch: authApp.fetch, port: 0, websocket })

    // Envoy service (with ADS gRPC on a pre-allocated port)
    const tempXds = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const xdsPort = tempXds.port
    tempXds.stop()

    const envoyConfig = CatalystConfigSchema.parse({
      node: { name: 'envoy-node', domains: ['somebiz.local.io'] },
      envoy: { adminPort: 9901, xdsPort, bindAddress: '0.0.0.0' },
      port: 0,
    })
    envoyService = await EnvoyService.create({ config: envoyConfig })

    const envoyApp = new Hono()
    envoyApp.route('/', envoyService.handler)
    envoyServer = Bun.serve({ fetch: envoyApp.fetch, port: 0, websocket })

    // Orchestrator (connects to auth + envoy service)
    const tempOrch = Bun.serve({ fetch: () => new Response(''), port: 0 })
    const orchPort = tempOrch.port
    tempOrch.stop()

    const orchConfig = CatalystConfigSchema.parse({
      node: {
        name: 'node-a.somebiz.local.io',
        domains: ['somebiz.local.io'],
        endpoint: `ws://localhost:${orchPort}/rpc`,
      },
      orchestrator: {
        ibgp: { secret: 'test-secret' },
        auth: {
          endpoint: `ws://localhost:${authServer.port}/rpc`,
          systemToken,
        },
        envoyConfig: {
          endpoint: `ws://localhost:${envoyServer.port}/api`,
          portRange: [[ENVOY_LISTENER_PORT, ENVOY_LISTENER_PORT]],
        },
      },
      port: orchPort,
    })
    orchService = await OrchestratorService.create({ config: orchConfig })

    const orchApp = new Hono()
    orchApp.route('/', orchService.handler)
    orchServer = Bun.serve({ fetch: orchApp.fetch, port: orchPort, websocket })

    // ── 4. Mint CLI token ──────────────────────────────────────────
    const mintResult = await mintTokenHandler({
      subject: 'test-cli',
      principal: 'CATALYST::ADMIN',
      name: 'Test CLI',
      type: 'service',
      authUrl: `ws://localhost:${authServer.port}/rpc`,
      token: systemToken,
    })
    if (!mintResult.success) throw new Error(`Failed to mint CLI token: ${mintResult.error}`)
    const cliToken = mintResult.data.token

    // ── 5. Start Envoy proxy container ─────────────────────────────
    // Start Envoy BEFORE creating routes so the ADS stream is established
    // first. The route creation (step 6) will push the snapshot via the
    // watcher callback over the already-connected stream, avoiding a race
    // where the initial sendSnapshot on connect drops the CDS write.
    console.log(`[setup] Starting Envoy proxy (ADS at host.docker.internal:${xdsPort})...`)
    const bootstrapYaml = generateBootstrapYaml(xdsPort)

    envoyContainer = await new GenericContainer('envoyproxy/envoy:v1.32-latest')
      .withNetwork(network)
      .withNetworkAliases('envoy-proxy')
      .withExposedPorts(ENVOY_LISTENER_PORT, 9901)
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withCopyContentToContainer([{ content: bootstrapYaml, target: '/etc/envoy/envoy.yaml' }])
      .withCommand(['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info'])
      .withWaitStrategy(Wait.forHttp('/server_info', 9901))
      .withStartupTimeout(120_000)
      .start()

    envoyMappedPort = envoyContainer.getMappedPort(ENVOY_LISTENER_PORT)
    adminMappedPort = envoyContainer.getMappedPort(9901)

    // Brief wait for ADS stream to fully establish
    await new Promise((r) => setTimeout(r, 500))

    // ── 6. Create route (endpoint uses Docker DNS hostname) ────────
    // The endpoint `http://books:8080/graphql` uses the Docker network
    // alias so Envoy proxy (inside Docker) can reach books-api.
    // Creating the route AFTER Envoy connects ensures the snapshot push
    // goes through the watcher callback on the established ADS stream.
    console.log('[setup] Creating books-api route...')
    const routeResult = await createRouteHandler({
      name: 'books-api',
      endpoint: 'http://books:8080/graphql',
      protocol: 'http:graphql',
      orchestratorUrl: `ws://localhost:${orchPort}/rpc`,
      token: cliToken,
    })
    if (!routeResult.success) throw new Error(`Failed to create route: ${routeResult.error}`)

    // ── 7. Wait for dynamic listener ───────────────────────────────
    // Envoy receives CDS + LDS from ADS, then creates the listener.
    console.log('[setup] Waiting for Envoy to create dynamic listener...')
    await waitForListener(adminMappedPort, 'ingress_books-api', 60_000)
    console.log('[setup] Envoy proxy ready — dynamic listener active.')
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    // 1. Stop containers (they depend on host services)
    await envoyContainer?.stop().catch(() => {})
    await booksContainer?.stop().catch(() => {})
    await network?.stop().catch(() => {})

    // 2. Stop Bun servers (synchronous)
    orchServer?.stop()
    envoyServer?.stop()
    authServer?.stop()

    // 3. Shutdown Catalyst services (async cleanup)
    await orchService?.shutdown()
    await envoyService?.shutdown()
    await authService?.shutdown()
  }, SETUP_TIMEOUT)

  it(
    'routes HTTP traffic through Envoy proxy to books-api',
    async () => {
      const response = await fetch(`http://localhost:${envoyMappedPort}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ books { title author } }' }),
      })

      expect(response.ok).toBe(true)
      const json = (await response.json()) as {
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
    'Envoy admin shows correct listener and cluster',
    async () => {
      // Verify the dynamic listener was created by xDS
      const listenersRes = await fetch(`http://localhost:${adminMappedPort}/listeners?format=json`)
      const listenersText = await listenersRes.text()
      expect(listenersText).toContain('ingress_books-api')

      // Verify the upstream cluster points to books-api
      const clustersRes = await fetch(`http://localhost:${adminMappedPort}/clusters?format=json`)
      const clustersText = await clustersRes.text()
      expect(clustersText).toContain('local_books-api')
    },
    TEST_TIMEOUT
  )
})
