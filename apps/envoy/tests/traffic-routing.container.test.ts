import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import * as grpc from '@grpc/grpc-js'
import { CatalystConfigSchema } from '@catalyst/config'
import { AuthService } from '@catalyst/authorization'
import { createTestWebSocketServer, createTestServer, type TestServerInfo } from '@catalyst/service'
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
  let authServer: TestServerInfo
  let booksServer: TestServerInfo
  let envoyServer: TestServerInfo
  let orchServer: TestServerInfo

  let authService: AuthService
  let envoyService: EnvoyService
  let orchService: OrchestratorService

  let systemToken: string
  let cliToken: string
  let xdsPort: number
  let ports: { auth: number; books: number; envoy: number; orchestrator: number }

  beforeAll(async () => {
    // ── 1. Start Auth Service ──────────────────────────────────────
    // Service MUST be created inside the factory so its WebSocket routes
    // capture the correct upgradeWebSocket binding from @hono/node-ws.
    const authConfig = CatalystConfigSchema.parse({
      node: { name: 'auth-node', domains: ['somebiz.local.io'] },
      auth: { keysDb: ':memory:', tokensDb: ':memory:' },
      port: 0,
    })

    authServer = await createTestWebSocketServer(async () => {
      authService = await AuthService.create({ config: authConfig })
      systemToken = authService.systemToken
      const app = new Hono()
      app.route('/', authService.handler)
      return app
    })

    // ── 2. Start Books API ─────────────────────────────────────────
    const booksModule = await import('../../../examples/books-api/src/index.js')
    booksServer = await createTestServer(booksModule.default)

    // ── 3. Start Envoy Service (with ADS gRPC) ────────────────────
    // Pre-allocate the xDS port
    const tempXds = await createTestServer({ fetch: () => new Response('') })
    xdsPort = tempXds.port
    tempXds.stop()

    envoyServer = await createTestWebSocketServer(async () => {
      const envoyConfig = CatalystConfigSchema.parse({
        node: { name: 'envoy-node', domains: ['somebiz.local.io'] },
        envoy: { adminPort: 9901, xdsPort, bindAddress: '0.0.0.0' },
        port: 0,
      })
      envoyService = await EnvoyService.create({ config: envoyConfig })
      const app = new Hono()
      app.route('/', envoyService.handler)
      return app
    })

    // ── 4. Start Orchestrator ──────────────────────────────────────
    const tempOrch = await createTestServer({ fetch: () => new Response('') })
    const orchPort = tempOrch.port
    tempOrch.stop()

    orchServer = await createTestWebSocketServer(
      async () => {
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
        const app = new Hono()
        app.route('/', orchService.handler)
        return app
      },
      { port: orchPort }
    )

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

      // Subscribe to CDS and LDS (server only sends after subscribe)
      const RequestType = root.lookupType('envoy.service.discovery.v3.DiscoveryRequest')
      const cdsReq = RequestType.fromObject({ type_url: CLUSTER_TYPE_URL })
      stream.write(Buffer.from(RequestType.encode(cdsReq).finish()))
      const ldsReq = RequestType.fromObject({ type_url: LISTENER_TYPE_URL })
      stream.write(Buffer.from(RequestType.encode(ldsReq).finish()))

      await waitForResponses(2)

      // CDS response: find books-api cluster among all clusters
      // (orchestrator may register additional service data channels)
      const cdsResponse = responses.find((r) => r.type_url === CLUSTER_TYPE_URL)
      expect(cdsResponse).toBeDefined()
      expect(cdsResponse!.resources.length).toBeGreaterThanOrEqual(1)

      // Decode all clusters and find books-api
      const clusters = cdsResponse!.resources.map((res) => {
        const any = AnyType.toObject(AnyType.fromObject(res), { defaults: true }) as {
          type_url: string
          value: Uint8Array
        }
        expect(any.type_url).toBe(CLUSTER_TYPE_URL)
        return ClusterType.toObject(ClusterType.decode(any.value as Uint8Array), {
          defaults: true,
        }) as { name: string; load_assignment: { cluster_name: string } }
      })

      const booksCluster = clusters.find((c) => c.name === 'local_books-api')
      expect(booksCluster).toBeDefined()
      expect(booksCluster!.load_assignment.cluster_name).toBe('local_books-api')

      // LDS response: find books-api listener among all listeners
      const ldsResponse = responses.find((r) => r.type_url === LISTENER_TYPE_URL)
      expect(ldsResponse).toBeDefined()
      expect(ldsResponse!.resources.length).toBeGreaterThanOrEqual(1)

      // Decode all listeners and find books-api
      const listeners = ldsResponse!.resources.map((res) => {
        const any = AnyType.toObject(AnyType.fromObject(res), { defaults: true }) as {
          type_url: string
          value: Uint8Array
        }
        expect(any.type_url).toBe(LISTENER_TYPE_URL)
        return ListenerType.toObject(ListenerType.decode(any.value as Uint8Array), {
          defaults: true,
        }) as {
          name: string
          address: { socket_address: { address: string; port_value: number } }
        }
      })

      const booksListener = listeners.find((l) => l.name === 'ingress_books-api')
      expect(booksListener).toBeDefined()
      expect(booksListener!.address.socket_address.port_value).toBeGreaterThanOrEqual(10000)
      expect(booksListener!.address.socket_address.port_value).toBeLessThanOrEqual(10100)
    } finally {
      stream.end()
      client.close()
    }
  })
})
