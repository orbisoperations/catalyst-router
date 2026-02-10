import { Hono } from 'hono'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'

import type { CatalystService } from './catalyst-service.js'

export interface CatalystHonoServerOptions {
  /** Port to listen on. Defaults to 3000. */
  port?: number
  /** Hostname to bind to. Defaults to '0.0.0.0'. */
  hostname?: string
  /** Services whose shutdown() will be called on stop. */
  services?: CatalystService[]
  /** Paths to exclude from telemetry middleware. Defaults to ['/', '/health']. */
  telemetryIgnorePaths?: string[]
  /** Bun WebSocket handler (from hono/bun `websocket`). Required for RPC-over-WebSocket. */
  websocket?: unknown
}

/**
 * Generic Hono server wrapper with standard lifecycle management.
 *
 * Wraps a Hono handler (typically a service's `.handler` route group) with:
 * - Telemetry middleware (HTTP request tracing + metrics)
 * - Standard `/health` endpoint
 * - `Bun.serve()` binding
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
  private _server: ReturnType<typeof Bun.serve> | undefined
  private _shutdownHandlers: (() => Promise<void>)[] = []

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

    const serveOptions: Parameters<typeof Bun.serve>[0] = {
      fetch: app.fetch,
      port,
      hostname,
    }
    if (this._options.websocket) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(serveOptions as any).websocket = this._options.websocket
    }
    this._server = Bun.serve(serveOptions)

    // Hard fail if the requested port was unavailable
    if (this._server.port !== port) {
      const actualPort = this._server.port
      this._server.stop()
      this._server = undefined
      throw new Error(`Port ${port} is already in use (server bound to ${actualPort} instead)`)
    }

    // Wire graceful shutdown
    const shutdownHandler = async () => {
      await this.stop()
      process.exit(0)
    }
    this._shutdownHandlers.push(shutdownHandler)
    process.on('SIGTERM', shutdownHandler)
    process.on('SIGINT', shutdownHandler)

    const names = serviceNames.length > 0 ? ` [${serviceNames.join(', ')}]` : ''
    console.log(`Catalyst server${names} listening on ${hostname}:${port}`)

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
      this._server.stop()
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
