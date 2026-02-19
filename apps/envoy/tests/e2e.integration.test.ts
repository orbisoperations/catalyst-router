import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { newWebSocketRpcSession } from 'capnweb'
import { CatalystConfigSchema } from '@catalyst/config'
import { AuthService } from '@catalyst/authorization'
import { EnvoyService } from '../src/service.js'
import { OrchestratorService } from '../../orchestrator/src/service.js'
import { mintTokenHandler } from '../../cli/src/handlers/auth-token-handlers.js'
import {
  createRouteHandler,
  listRoutesHandler,
} from '../../cli/src/handlers/node-route-handlers.js'
import type { EnvoyRpcServer } from '../src/rpc/server.js'

/**
 * End-to-end integration test: Auth -> Orchestrator -> Envoy -> Books API
 *
 * Starts 4 real Bun servers in-process:
 * 1. Auth service (in-memory DBs, mints system admin token)
 * 2. Books API (GraphQL service)
 * 3. Envoy service (receives xDS config via RPC)
 * 4. Orchestrator (connects to auth, allocates ports, pushes config to envoy)
 *
 * Uses CLI handlers with real auth tokens to exercise the full control plane.
 */
describe('E2E: CLI -> Orchestrator -> Envoy Service (with Auth)', () => {
  // Servers
  let authServer: ReturnType<typeof serve>
  let booksServer: ReturnType<typeof serve>
  let envoyServer: ReturnType<typeof serve>
  let orchServer: ReturnType<typeof serve>

  // Services (for shutdown)
  let authService: AuthService
  let envoyService: EnvoyService
  let orchService: OrchestratorService

  // Runtime state
  let systemToken: string
  let cliToken: string
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
    const { injectWebSocket: authInjectWs } = createNodeWebSocket({ app: authApp })
    authApp.route('/', authService.handler)
    authServer = serve({ fetch: authApp.fetch, port: 0 })
    authInjectWs(authServer)

    // ── 2. Start Books API ─────────────────────────────────────────
    const booksModule = await import('../../../examples/books-api/src/index.js')
    booksServer = serve({
      fetch: booksModule.default.fetch,
      port: 0,
    })

    // ── 3. Start Envoy Service ─────────────────────────────────────
    const envoyConfig = CatalystConfigSchema.parse({
      node: { name: 'envoy-node', domains: ['somebiz.local.io'] },
      envoy: { adminPort: 9901, xdsPort: 18000, bindAddress: '0.0.0.0' },
      port: 0,
    })
    envoyService = await EnvoyService.create({ config: envoyConfig })

    const envoyApp = new Hono()
    const { injectWebSocket: envoyInjectWs } = createNodeWebSocket({ app: envoyApp })
    envoyApp.route('/', envoyService.handler)
    envoyServer = serve({ fetch: envoyApp.fetch, port: 0 })
    envoyInjectWs(envoyServer)

    // ── 4. Start Orchestrator ──────────────────────────────────────
    // Pre-allocate a port for the orchestrator so we can set node.endpoint
    const tempServer = serve({ fetch: () => new Response(''), port: 0 })
    const orchPort = (tempServer.address() as { port: number }).port
    tempServer.close()

    const authPort = (authServer.address() as { port: number }).port
    const envoyPort = (envoyServer.address() as { port: number }).port

    const orchConfig = CatalystConfigSchema.parse({
      node: {
        name: 'node-a.somebiz.local.io', // Must end with domain suffix
        domains: ['somebiz.local.io'],
        endpoint: `ws://localhost:${orchPort}/rpc`,
      },
      orchestrator: {
        ibgp: { secret: 'test-secret' },
        auth: {
          endpoint: `ws://localhost:${authPort}/rpc`,
          systemToken,
        },
        envoyConfig: {
          endpoint: `ws://localhost:${envoyPort}/api`,
          portRange: [[10000, 10100]],
        },
      },
      port: orchPort,
    })
    orchService = await OrchestratorService.create({ config: orchConfig })

    const orchApp = new Hono()
    const { injectWebSocket: orchInjectWs } = createNodeWebSocket({ app: orchApp })
    orchApp.route('/', orchService.handler)
    orchServer = serve({ fetch: orchApp.fetch, port: orchPort })
    orchInjectWs(orchServer)

    ports = {
      auth: authPort,
      books: (booksServer.address() as { port: number }).port,
      envoy: envoyPort,
      orchestrator: orchPort,
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
    // Stop servers first, then services
    orchServer?.close()
    envoyServer?.close()
    booksServer?.close()
    authServer?.close()

    await orchService?.shutdown()
    await envoyService?.shutdown()
    await authService?.shutdown()
  }, 10000)

  it('minted valid auth tokens', () => {
    expect(systemToken).toBeDefined()
    expect(systemToken).toMatch(/^eyJ/)
    expect(cliToken).toBeDefined()
    expect(cliToken).toMatch(/^eyJ/)
  })

  it('publishes books-api as data channel via CLI handler', async () => {
    const result = await createRouteHandler({
      name: 'books-api',
      endpoint: `http://localhost:${ports.books}/graphql`,
      protocol: 'http:graphql',
      orchestratorUrl: `ws://localhost:${ports.orchestrator}/rpc`,
      token: cliToken,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('books-api')
    }
  })

  it('lists data channels via CLI handler and sees books-api with envoyPort', async () => {
    // Small delay to allow notification pipeline to complete
    await new Promise((r) => setTimeout(r, 200))

    const result = await listRoutesHandler({
      orchestratorUrl: `ws://localhost:${ports.orchestrator}/rpc`,
      token: cliToken,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.error)

    const routes = result.data.routes
    expect(routes.length).toBeGreaterThanOrEqual(1)

    const booksRoute = routes.find((r) => r.name === 'books-api')
    expect(booksRoute).toBeDefined()
    expect(booksRoute?.source).toBe('local')
    expect(booksRoute?.protocol).toBe('http:graphql')
    expect(booksRoute?.endpoint).toBe(`http://localhost:${ports.books}/graphql`)

    // envoyPort should be allocated in the 10000-10100 range
    if (booksRoute && 'envoyPort' in booksRoute) {
      expect(typeof booksRoute.envoyPort).toBe('number')
      expect(booksRoute.envoyPort).toBeGreaterThanOrEqual(10000)
      expect(booksRoute.envoyPort).toBeLessThanOrEqual(10100)
    }
  })

  it('envoy service received correct route config via RPC', async () => {
    // Small delay to allow envoy config push to complete
    await new Promise((r) => setTimeout(r, 200))

    // Connect to envoy service RPC and check routes
    const ws = new WebSocket(`ws://localhost:${ports.envoy}/api`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(e))
    })
    const rpc = newWebSocketRpcSession<EnvoyRpcServer>(ws as unknown as WebSocket)
    const routes = await rpc.getRoutes()

    expect(routes.local.length).toBeGreaterThanOrEqual(1)

    const booksRoute = routes.local.find((r: { name: string }) => r.name === 'books-api')
    expect(booksRoute).toBeDefined()
    expect(booksRoute?.endpoint).toBe(`http://localhost:${ports.books}/graphql`)
    expect(booksRoute?.protocol).toBe('http:graphql')

    // envoyPort should be set by the orchestrator's port allocator
    if (booksRoute && 'envoyPort' in booksRoute) {
      expect(typeof booksRoute.envoyPort).toBe('number')
      expect(booksRoute.envoyPort).toBeGreaterThanOrEqual(10000)
    }

    ws.close()
  })

  it('books-api GraphQL endpoint responds with books data', async () => {
    const response = await fetch(`http://localhost:${ports.books}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ books { title author } }' }),
    })

    expect(response.ok).toBe(true)

    const json = (await response.json()) as {
      data: { books: Array<{ title: string; author: string }> }
    }
    expect(json.data.books).toHaveLength(3)

    const titles = json.data.books.map((b) => b.title)
    expect(titles).toContain('The Lord of the Rings')
    expect(titles).toContain('Pride and Prejudice')
    expect(titles).toContain('The Hobbit')
  })
})
