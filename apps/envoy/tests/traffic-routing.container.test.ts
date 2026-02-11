import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import * as grpc from '@grpc/grpc-js'
import { CatalystConfigSchema } from '@catalyst/config'
import { AuthService } from '@catalyst/authorization'
import { EnvoyService } from '../src/service.js'
import { OrchestratorService } from '../../orchestrator/src/service.js'
import { mintTokenHandler } from '../../cli/src/handlers/auth-token-handlers.js'
import { createRouteHandler } from '../../cli/src/handlers/node-route-handlers.js'
import { getProtoRoot, LISTENER_TYPE_URL, CLUSTER_TYPE_URL } from '../src/xds/proto-encoding.js'

const ADS_SERVICE_PATH =
  '/envoy.service.discovery.v3.AggregatedDiscoveryService/StreamAggregatedResources'

/**
 * Traffic routing integration test: Full pipeline with xDS verification.
 *
 * Starts auth, books-api, envoy service (with ADS gRPC), and orchestrator.
 * Creates a route via CLI, then connects a gRPC client to verify the ADS
 * server delivers correct protobuf-encoded Listener and Cluster resources.
 *
 * This proves the full pipeline: CLI -> Orchestrator -> Envoy RPC ->
 * Snapshot Cache -> ADS gRPC -> protobuf DiscoveryResponse.
 */
describe('Traffic Routing: Full Pipeline with ADS gRPC', () => {
  let authServer: ReturnType<typeof Bun.serve>
  let booksServer: ReturnType<typeof Bun.serve>
  let envoyServer: ReturnType<typeof Bun.serve>
  let orchServer: ReturnType<typeof Bun.serve>

  let authService: AuthService
  let envoyService: EnvoyService
  let orchService: OrchestratorService

  let systemToken: string
  let cliToken: string
  let xdsPort: number
  let ports: { auth: number; books: number; envoy: number; orchestrator: number }

  beforeAll(async () => {
    // ── 1. Start Auth Service ──────────────────────────────────────
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

    // ── 2. Start Books API ─────────────────────────────────────────
    const booksModule = await import('../../../examples/books-api/src/index.js')
    booksServer = Bun.serve({
      fetch: booksModule.default.fetch,
      port: 0,
    })

    // ── 3. Start Envoy Service (with ADS gRPC) ────────────────────
    // Pre-allocate the xDS port
    const tempXds = Bun.serve({ fetch: () => new Response(''), port: 0 })
    xdsPort = tempXds.port
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

    // ── 4. Start Orchestrator ──────────────────────────────────────
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
          portRange: [[10000, 10100]],
        },
      },
      port: orchPort,
    })
    orchService = await OrchestratorService.create({ config: orchConfig })

    const orchApp = new Hono()
    orchApp.route('/', orchService.handler)
    orchServer = Bun.serve({ fetch: orchApp.fetch, port: orchPort, websocket })

    ports = {
      auth: authServer.port,
      books: booksServer.port,
      envoy: envoyServer.port,
      orchestrator: orchServer.port,
    }

    // ── 5. Mint CLI token ──────────────────────────────────────────
    const mintResult = await mintTokenHandler({
      subject: 'test-cli',
      principal: 'CATALYST::ADMIN',
      name: 'Test CLI',
      type: 'service',
      authUrl: `ws://localhost:${ports.auth}/rpc`,
      token: systemToken,
    })
    if (!mintResult.success) {
      throw new Error(`Failed to mint CLI token: ${mintResult.error}`)
    }
    cliToken = mintResult.data.token
  }, 30000)

  afterAll(async () => {
    orchServer?.stop()
    envoyServer?.stop()
    booksServer?.stop()
    authServer?.stop()

    await orchService?.shutdown()
    await envoyService?.shutdown()
    await authService?.shutdown()
  }, 10000)

  it('ADS gRPC server delivers protobuf CDS and LDS after route creation', async () => {
    // Create the route via CLI handler
    const result = await createRouteHandler({
      name: 'books-api',
      endpoint: `http://localhost:${ports.books}/graphql`,
      protocol: 'http:graphql',
      orchestratorUrl: `ws://localhost:${ports.orchestrator}/rpc`,
      token: cliToken,
    })
    expect(result.success).toBe(true)

    // Wait for the snapshot to propagate
    await new Promise((r) => setTimeout(r, 300))

    // Connect a gRPC client to the ADS server (simulating Envoy)
    const client = new grpc.Client(`localhost:${xdsPort}`, grpc.credentials.createInsecure())

    const root = getProtoRoot()
    const ResponseType = root.lookupType('envoy.service.discovery.v3.DiscoveryResponse')
    const AnyType = root.lookupType('google.protobuf.Any')
    const ListenerType = root.lookupType('envoy.config.listener.v3.Listener')
    const ClusterType = root.lookupType('envoy.config.cluster.v3.Cluster')

    const stream = client.makeBidiStreamRequest(
      ADS_SERVICE_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v
    )

    try {
      // Collect responses
      const responses: Array<{
        version_info: string
        type_url: string
        nonce: string
        resources: Array<{ type_url: string; value: Uint8Array }>
      }> = []

      const waitForResponses = (count: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(new Error(`Timeout waiting for ${count} responses (got ${responses.length})`)),
            5000
          )

          const check = () => {
            if (responses.length >= count) {
              clearTimeout(timeout)
              resolve()
            }
          }

          stream.on('data', (buffer: Buffer) => {
            const msg = ResponseType.decode(buffer)
            const obj = ResponseType.toObject(msg, {
              defaults: true,
              arrays: true,
            }) as (typeof responses)[0]
            responses.push(obj)
            check()
          })

          check()
        })

      await waitForResponses(2)

      // First response: CDS
      const cdsResponse = responses.find((r) => r.type_url === CLUSTER_TYPE_URL)
      expect(cdsResponse).toBeDefined()
      expect(cdsResponse!.resources.length).toBe(1)

      // Decode the cluster from the Any wrapper
      const clusterAny = AnyType.toObject(AnyType.fromObject(cdsResponse!.resources[0]), {
        defaults: true,
      }) as { type_url: string; value: Uint8Array }
      expect(clusterAny.type_url).toBe(CLUSTER_TYPE_URL)

      const cluster = ClusterType.toObject(ClusterType.decode(clusterAny.value as Uint8Array), {
        defaults: true,
      }) as { name: string; load_assignment: { cluster_name: string } }
      expect(cluster.name).toBe('local_books-api')
      expect(cluster.load_assignment.cluster_name).toBe('local_books-api')

      // Second response: LDS
      const ldsResponse = responses.find((r) => r.type_url === LISTENER_TYPE_URL)
      expect(ldsResponse).toBeDefined()
      expect(ldsResponse!.resources.length).toBe(1)

      // Decode the listener from the Any wrapper
      const listenerAny = AnyType.toObject(AnyType.fromObject(ldsResponse!.resources[0]), {
        defaults: true,
      }) as { type_url: string; value: Uint8Array }
      expect(listenerAny.type_url).toBe(LISTENER_TYPE_URL)

      const listener = ListenerType.toObject(ListenerType.decode(listenerAny.value as Uint8Array), {
        defaults: true,
      }) as {
        name: string
        address: {
          socket_address: { address: string; port_value: number }
        }
      }
      expect(listener.name).toBe('ingress_books-api')
      expect(listener.address.socket_address.port_value).toBeGreaterThanOrEqual(10000)
      expect(listener.address.socket_address.port_value).toBeLessThanOrEqual(10100)
    } finally {
      stream.end()
      client.close()
    }
  })
})
