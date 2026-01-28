/**
 * @catalyst/sdk — CatalystService
 *
 * Standardized service entrypoint for Catalyst Node services.
 *
 * WHY: Every Catalyst service repeats the same bootstrap boilerplate:
 * create Hono app → mount /health → wire SIGTERM → export { fetch, port }.
 * CatalystService extracts this into a single class that optionally
 * integrates @catalyst/telemetry for traces, metrics, and logs.
 *
 * WHY optional telemetry: Not all services need full OTEL instrumentation
 * (e.g. CLI tools, test harnesses). When telemetry is disabled, the class
 * falls back to @opentelemetry/api's built-in no-op implementations,
 * so consuming code never needs null checks.
 *
 * @see packages/auth/src/index.ts — example service bootstrap pattern
 * @see packages/gateway/src/index.ts — example service bootstrap pattern
 */

import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { trace, metrics } from '@opentelemetry/api'
import type { Tracer, Meter } from '@opentelemetry/api'

export interface ServiceOptions {
  /**
   * Service name used for logging and OTEL resource attributes.
   *
   * WHY required: The service name is the primary identifier in traces,
   * metrics, and logs. Without it, spans show as "unknown_service".
   */
  name: string

  /**
   * Port to listen on (default: process.env.PORT || 3000).
   *
   * WHY env fallback: Container orchestrators typically inject PORT via
   * environment. Explicit option takes precedence for dev/testing.
   */
  port?: number

  /**
   * Hostname to bind to (default: '0.0.0.0').
   *
   * WHY 0.0.0.0: Required for containers where the service must accept
   * connections from outside the container network namespace.
   */
  hostname?: string

  /**
   * Path for the health check endpoint (default: '/health').
   *
   * WHY '/health': Standard Kubernetes liveness/readiness probe path.
   * Override for services that need a different convention.
   */
  healthPath?: string
}

/**
 * Standardized Catalyst service entrypoint.
 *
 * Usage:
 * ```ts
 * import { CatalystService } from '@catalyst/sdk'
 *
 * const service = new CatalystService({ name: 'my-service', port: 4001 })
 *
 * service.app.get('/', (c) => c.text('Hello'))
 * service.app.route('/rpc', rpcApp)
 *
 * service.onShutdown(async () => {
 *   await db.close()
 * })
 *
 * export default service.serve()
 * ```
 */
export class CatalystService {
  readonly app: Hono
  readonly port: number
  readonly hostname: string

  private readonly _name: string
  private readonly _shutdownCallbacks: Array<() => Promise<void> | void> = []
  private _signalHandler: (() => void) | null = null

  constructor(options: ServiceOptions) {
    // Validate service name — required for telemetry and logging
    if (!options.name || options.name.trim() === '') {
      throw new Error('[CatalystService] name is required and must be non-empty')
    }

    this._name = options.name
    this.port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000)
    this.hostname = options.hostname ?? '0.0.0.0'

    this.app = new Hono()

    // Mount health endpoint
    const healthPath = options.healthPath ?? '/health'
    this.app.get(healthPath, (c) => c.json({ status: 'ok' }))

    /**
     * WHY SIGTERM/SIGINT exit the process: In Kubernetes, SIGTERM signals
     * the pod to terminate. SIGINT (Ctrl+C) is used in local development.
     * Both should trigger graceful shutdown. If the process doesn't exit,
     * the kubelet waits for the grace period then sends SIGKILL.
     */
    this._signalHandler = () => {
      this.shutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(`[${this._name}] Shutdown error:`, err)
          process.exit(1)
        })
    }
    process.on('SIGTERM', this._signalHandler)
    process.on('SIGINT', this._signalHandler)
  }

  /**
   * Get the service name.
   *
   * WHY public accessor: Useful for logging, debugging, and when consumers
   * need to reference the service name (e.g., for custom metrics labels).
   */
  get name(): string {
    return this._name
  }

  /**
   * Get a Tracer for this service.
   *
   * WHY this returns the global tracer: If @catalyst/telemetry has been
   * initialized via initTelemetry(), this returns a real tracer. Otherwise,
   * @opentelemetry/api returns a no-op tracer that silently discards spans.
   * Either way, consuming code works without null checks.
   */
  get tracer(): Tracer {
    return trace.getTracer(this._name)
  }

  /**
   * Get a Meter for this service.
   *
   * WHY this returns the global meter: Same rationale as tracer — real
   * or no-op depending on whether telemetry was initialized.
   */
  get meter(): Meter {
    return metrics.getMeter(this._name)
  }

  /**
   * Register a callback to run during graceful shutdown.
   *
   * WHY callbacks not events: Callbacks are awaited sequentially, ensuring
   * ordered cleanup (e.g. flush logs before closing DB connections).
   * Event emitters don't guarantee ordering or async completion.
   */
  onShutdown(fn: () => Promise<void> | void): void {
    this._shutdownCallbacks.push(fn)
  }

  /**
   * Build the Bun server configuration.
   *
   * WHY this returns an object (not starts a server): Bun's runtime
   * expects `export default { fetch, port, websocket }` at the module level.
   * Starting the server is Bun's responsibility, not ours.
   */
  serve(): { fetch: Hono['fetch']; port: number; hostname: string; websocket: typeof websocket } {
    /**
     * WHY .bind(): Bun's runtime calls `fetch(req, server)` on the returned
     * object. Without binding, `this` inside Hono's fetch is the plain object,
     * not the Hono instance — causing runtime errors or silent failures.
     *
     * WHY websocket: Enables WebSocket upgrade support via Hono's upgradeWebSocket.
     * Without this, services cannot use Cap'n Proto RPC or other WS protocols.
     */
    return {
      fetch: this.app.fetch.bind(this.app),
      port: this.port,
      hostname: this.hostname,
      websocket,
    }
  }

  /**
   * Run all shutdown callbacks and clean up resources.
   *
   * WHY sequential execution: Shutdown callbacks may have ordering
   * dependencies (e.g. flush telemetry before closing network connections).
   * Running them in parallel could cause lost data.
   *
   * WHY timeout: A misbehaving callback (e.g. exporter blocked on a stalled
   * collector) should not hang the process indefinitely. The default 30s
   * matches Kubernetes' default terminationGracePeriodSeconds.
   *
   * @param timeoutMs — Maximum time for all callbacks to complete (default: 30000ms)
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    // Remove signal handlers to avoid double-shutdown
    if (this._signalHandler) {
      process.removeListener('SIGTERM', this._signalHandler)
      process.removeListener('SIGINT', this._signalHandler)
      this._signalHandler = null
    }

    const runCallbacks = async () => {
      for (const fn of this._shutdownCallbacks) {
        try {
          await fn()
        } catch (err) {
          console.error(`[${this._name}] Shutdown callback error:`, err)
        }
      }
    }

    /**
     * WHY we track timeoutId: When runCallbacks() completes before the timeout,
     * Promise.race resolves but the setTimeout continues running. Without
     * clearing it, the timer leaks and eventually fires a rejected promise
     * that nobody is listening to.
     */
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Shutdown timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    })

    try {
      await Promise.race([runCallbacks(), timeout])
    } catch (err) {
      console.error(`[${this._name}]`, err instanceof Error ? err.message : err)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }
}
