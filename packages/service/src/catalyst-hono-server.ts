import { createAdaptorServer } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { getLogger } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { Hono } from 'hono'

import type { CatalystService } from './catalyst-service.js'

/**
 * The `upgradeWebSocket` function created by `createNodeWebSocket`.
 *
 * RPC handlers that need WebSocket support should import this from
 * `@catalyst/service` and pass it to `newRpcResponse()`.
 *
 * It is initialized lazily when a `CatalystHonoServer` is constructed,
 * so it is always available before `start()` is called.
 */
export let upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket']

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

  /** Start listening. Wires SIGTERM/SIGINT for graceful shutdown. */
  start(): this {
    if (this._server) {
      throw new Error('Server is already running. Call stop() before starting again.')
    }

    const port = this._options.port ?? 3000
    const hostname = this._options.hostname ?? '0.0.0.0'
    const ignorePaths = this._options.telemetryIgnorePaths ?? ['/', '/health']

    const app = new Hono()

    // Wire Node.js WebSocket support via @hono/node-ws
    const nodeWs = createNodeWebSocket({ app })
    upgradeWebSocket = nodeWs.upgradeWebSocket
    this._injectWebSocket = nodeWs.injectWebSocket

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

    this._server.listen(port, hostname)

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
      const server = this._server
      this._server = undefined
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
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
