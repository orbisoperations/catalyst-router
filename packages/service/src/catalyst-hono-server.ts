import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { getLogger } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { Hono } from 'hono'

import type { CatalystService } from './catalyst-service.js'

/**
 * Internal reference to the current `upgradeWebSocket` implementation.
 * Set by CatalystHonoServer when the root Hono app is created.
 * Accessed by the exported `upgradeWebSocket` proxy.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _upgradeWebSocket: ((...args: any[]) => any) | undefined

/**
 * Re-exported `upgradeWebSocket` for use in service RPC handlers.
 *
 * This is a lazy proxy that delegates to the node-ws implementation
 * initialized by CatalystHonoServer. Services should import this
 * instead of `hono/bun`.
 *
 * @example
 * ```ts
 * import { upgradeWebSocket } from '@catalyst/service'
 * app.get('/rpc', (c) => newRpcResponse(c, target, { upgradeWebSocket }))
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const upgradeWebSocket = (...args: any[]): any => {
  if (!_upgradeWebSocket) {
    throw new Error(
      'upgradeWebSocket not initialized. Ensure CatalystHonoServer is constructed before defining WebSocket routes.'
    )
  }
  return _upgradeWebSocket(...args)
}

export interface CatalystHonoServerOptions {
  /** Port to listen on. Defaults to 3000. */
  port?: number
  /** Hostname to bind to. Defaults to '0.0.0.0'. */
  hostname?: string
  /** Services whose shutdown() will be called on stop. */
  services?: CatalystService[]
  /** Paths to exclude from telemetry middleware. Defaults to ['/', '/health']. */
  telemetryIgnorePaths?: string[]
}

/**
 * Generic Hono server wrapper with standard lifecycle management.
 *
 * Wraps a Hono handler (typically a service's `.handler` route group) with:
 * - Telemetry middleware (HTTP request tracing + metrics)
 * - Standard `/health` endpoint
 * - `@hono/node-server` binding
 * - WebSocket support via `@hono/node-ws`
 * - Graceful shutdown on SIGTERM/SIGINT
 *
 * @example
 * ```ts
 * const auth = await AuthService.create({ config })
 * catalystHonoServer(auth.handler, {
 *   services: [auth],
 *   port: config.port,
 * }).start()
 * ```
 *
 * @example Composed services
 * ```ts
 * const app = new Hono()
 * app.route('/auth', auth.handler)
 * app.route('/gateway', gateway.handler)
 *
 * catalystHonoServer(app, {
 *   services: [auth, gateway],
 * }).start()
 * ```
 */
export class CatalystHonoServer {
  private readonly _handler: Hono
  private readonly _options: CatalystHonoServerOptions
  private _server: Server | undefined
  private _shutdownHandlers: (() => Promise<void>)[] = []
  private readonly _logger = getLogger(['catalyst', 'hono-server'])
  private _injectWebSocket: ((server: Server) => void) | undefined

  constructor(handler: Hono, options?: CatalystHonoServerOptions) {
    this._handler = handler
    this._options = options ?? {}
  }

  /** Start listening. Wires SIGTERM/SIGINT for graceful shutdown. */
  start(): this {
    if (this._server) {
      throw new Error('Server is already running. Call stop() before starting again.')
    }

    const port = this._options.port ?? 3000
    const hostname = this._options.hostname ?? '0.0.0.0'
    const ignorePaths = this._options.telemetryIgnorePaths ?? ['/', '/health']

    const app = new Hono()

    // Initialize WebSocket support via @hono/node-ws
    const { injectWebSocket, upgradeWebSocket: nodeWsUpgrade } = createNodeWebSocket({ app })
    this._injectWebSocket = injectWebSocket
    _upgradeWebSocket = nodeWsUpgrade

    // Standard telemetry middleware
    app.use(telemetryMiddleware({ ignorePaths }))

    // Standard health endpoint
    const serviceNames = this._options.services?.map((s) => s.info.name) ?? []
    app.get('/health', (c) =>
      c.json({
        status: 'ok',
        services: serviceNames,
      })
    )

    // Mount the provided handler
    app.route('/', this._handler)

    this._server = serve({
      fetch: app.fetch,
      port,
      hostname,
    })

    // Inject WebSocket handler into the HTTP server
    injectWebSocket(this._server)

    // Wire graceful shutdown
    const shutdownHandler = async () => {
      await this.stop()
      process.exit(0)
    }
    this._shutdownHandlers.push(shutdownHandler)
    process.on('SIGTERM', shutdownHandler)
    process.on('SIGINT', shutdownHandler)

    const names = serviceNames.length > 0 ? ` [${serviceNames.join(', ')}]` : ''
    const logger = getLogger(['catalyst', 'server'])
    logger.info`Catalyst server${names} listening on ${hostname}:${port}`

    return this
  }

  /** Gracefully stop: shut down services, flush telemetry, close server. */
  async stop(): Promise<void> {
    // Shut down all registered services
    if (this._options.services) {
      await Promise.allSettled(this._options.services.map((s) => s.shutdown()))
    }

    // Stop the HTTP server
    if (this._server) {
      this._server.close()
      this._server = undefined
    }

    // Remove signal handlers to avoid duplicate calls
    for (const handler of this._shutdownHandlers) {
      process.removeListener('SIGTERM', handler)
      process.removeListener('SIGINT', handler)
    }
    this._shutdownHandlers = []
  }
}

/**
 * Convenience factory for creating a CatalystHonoServer.
 *
 * @example
 * ```ts
 * catalystHonoServer(auth.handler, { services: [auth], port: 4000 }).start()
 * ```
 */
export function catalystHonoServer(
  handler: Hono,
  options?: CatalystHonoServerOptions
): CatalystHonoServer {
  return new CatalystHonoServer(handler, options)
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

export interface TestServerInfo {
  server: Server
  port: number
  stop(): void
}

/**
 * Create a lightweight WebSocket-enabled test server.
 *
 * Accepts a factory function (instead of a pre-built handler) because
 * `upgradeWebSocket` must be initialized *before* any route that calls it.
 * The factory is invoked after `createNodeWebSocket` has been set up on the
 * root Hono app.
 *
 * @example
 * ```ts
 * const { port, stop } = await createTestWebSocketServer(() => {
 *   const rpc = new MyRpcServer()
 *   return createRpcHandler(rpc)
 * })
 * ```
 */
export async function createTestWebSocketServer(
  createHandler: () => Hono | Promise<Hono>,
  options?: { port?: number; hostname?: string }
): Promise<TestServerInfo> {
  const rootApp = new Hono()
  const { injectWebSocket, upgradeWebSocket: wsUpgrade } = createNodeWebSocket({ app: rootApp })
  _upgradeWebSocket = wsUpgrade

  // Per-request middleware: ensure _upgradeWebSocket points to THIS server's
  // function for each request. This is critical when multiple test servers
  // coexist — each createNodeWebSocket() has its own internal waiterMap, so
  // using the wrong upgradeWebSocket silently drops the WebSocket upgrade.
  rootApp.use('*', async (c, next) => {
    const prev = _upgradeWebSocket
    _upgradeWebSocket = wsUpgrade
    try {
      await next()
    } finally {
      _upgradeWebSocket = prev
    }
  })

  const handler = await createHandler()
  rootApp.route('/', handler)

  return new Promise<TestServerInfo>((resolve) => {
    const s = serve(
      { fetch: rootApp.fetch, port: options?.port ?? 0, hostname: options?.hostname },
      (info) => {
        injectWebSocket(s)
        resolve({ server: s, port: info.port, stop: () => s.close() })
      }
    )
  })
}

/**
 * Create a plain HTTP test server (no WebSocket).
 *
 * @example
 * ```ts
 * const { port, stop } = await createTestServer(app)
 * ```
 */
export async function createTestServer(
  app: Hono | { fetch: (req: Request) => Response | Promise<Response> },
  options?: { port?: number; hostname?: string }
): Promise<TestServerInfo> {
  const fetchFn = 'fetch' in app && typeof app.fetch === 'function' ? app.fetch : app
  return new Promise<TestServerInfo>((resolve) => {
    const s = serve(
      { fetch: fetchFn as any, port: options?.port ?? 0, hostname: options?.hostname },
      (info) => {
        resolve({ server: s, port: info.port, stop: () => s.close() })
      }
    )
  })
}
