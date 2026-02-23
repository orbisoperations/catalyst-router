import type { Server as HttpServer } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { getLogger } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'

import type { CatalystService } from './catalyst-service.js'

type UpgradeWebSocketFn = ReturnType<typeof createNodeWebSocket>['upgradeWebSocket']

/**
 * The `upgradeWebSocket` function created by `createNodeWebSocket`.
 *
 * @deprecated Use `getUpgradeWebSocket(c)` instead to support multiple
 * servers in the same process (e.g. integration tests).
 *
 * Initialized with a throwing sentinel so that accidental calls before
 * `CatalystHonoServer.start()` produce a clear error.
 */
export let upgradeWebSocket: UpgradeWebSocketFn = (() => {
  throw new Error(
    'upgradeWebSocket is not available — CatalystHonoServer.start() has not been called. ' +
    'Use getUpgradeWebSocket(c) instead.'
  )
}) as unknown as UpgradeWebSocketFn

/** Context key for per-server upgradeWebSocket. */
const WS_CTX_KEY = 'catalyst:upgradeWebSocket'

/**
 * Get the correct `upgradeWebSocket` for the current request.
 *
 * Prefers the per-server instance stored on the Hono context (set by
 * CatalystHonoServer middleware), falling back to the module-level
 * singleton for backward compatibility.
 */
export function getUpgradeWebSocket(c: Context): UpgradeWebSocketFn {
  return (c.get(WS_CTX_KEY) as UpgradeWebSocketFn) ?? upgradeWebSocket
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
 * - `@hono/node-server` binding with WebSocket support
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
  private _server: ServerType | undefined
  private _injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'] | undefined
  private _shutdownHandlers: (() => Promise<void>)[] = []
  private readonly _logger = getLogger(['catalyst', 'hono-server'])

  constructor(handler: Hono, options?: CatalystHonoServerOptions) {
    this._handler = handler
    this._options = options ?? {}
  }

  /** Start listening. Resolves once the server is bound. Wires SIGTERM/SIGINT for graceful shutdown. */
  async start(): Promise<this> {
    if (this._server) {
      throw new Error('Server is already running. Call stop() before starting again.')
    }

    const port = this._options.port ?? 3000
    const hostname = this._options.hostname ?? '0.0.0.0'
    const ignorePaths = this._options.telemetryIgnorePaths ?? ['/', '/health']

    const app = new Hono<{ Variables: Record<string, unknown> }>()

    // Wire Node.js WebSocket support via @hono/node-ws
    const nodeWs = createNodeWebSocket({ app })
    const localUpgradeWs = nodeWs.upgradeWebSocket
    upgradeWebSocket = localUpgradeWs
    this._injectWebSocket = nodeWs.injectWebSocket

    // Make the per-server upgradeWebSocket available on every request context.
    // This allows multiple CatalystHonoServers in the same process (integration tests)
    // where the module-level singleton would be overwritten by the last server.
    app.use('*', async (c, next) => {
      c.set(WS_CTX_KEY, localUpgradeWs)
      await next()
    })

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

    this._server = createAdaptorServer({
      fetch: app.fetch,
      hostname,
    })

    // Crash hard on port conflicts rather than silently misbehaving.
    // Attached before listen() so the handler is ready when the error fires.
    this._server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this._logger.error`Port ${port} is already in use`
        process.exit(1)
      }
      throw err
    })

    // Inject WebSocket handling into the HTTP server
    this._injectWebSocket(this._server)

    // Wait for the server to actually bind (required for port: 0)
    await new Promise<void>((resolve) => {
      this._server!.listen(port, hostname, () => resolve())
    })

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

  /** The port the server is listening on. Only valid after start(). */
  get port(): number {
    if (!this._server) throw new Error('Server is not running')
    const addr = this._server.address()
    if (typeof addr === 'string' || !addr) throw new Error('Cannot determine port')
    return addr.port
  }

  /** Gracefully stop: shut down services, flush telemetry, close server. */
  async stop(): Promise<void> {
    // Close the HTTP server first — force-close active connections so it resolves promptly.
    // Done before service shutdown so WebSocket handlers don't keep the server alive.
    if (this._server) {
      const server = this._server
      this._server = undefined
      ;(server as HttpServer).closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }

    // Shut down all registered services (flushes telemetry etc.)
    if (this._options.services) {
      await Promise.allSettled(this._options.services.map((s) => s.shutdown()))
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
