import type { Logger } from '@logtape/logtape'

/**
 * Execute an async operation with guaranteed WideEvent emission.
 *
 * Creates a WideEvent, passes it to the callback, and guarantees `.emit()` is
 * called via `finally` — even if the callback throws. On error, `.setError()`
 * is called before re-throwing so the emitted event captures failure details.
 *
 * This is the primary API for creating wide events. Prefer this over
 * `new WideEvent()` to eliminate the risk of lost telemetry on unexpected throws.
 */
export async function withWideEvent<T>(
  eventName: string,
  logger: Logger,
  fn: (event: WideEvent) => Promise<T>
): Promise<T> {
  const event = new WideEvent(eventName, logger)
  try {
    return await fn(event)
  } catch (err) {
    event.setError(err)
    throw err
  } finally {
    event.emit()
  }
}

/** Logger proxy that injects the parent WideEvent's `event.name` into every log call. */
export interface EventLogger {
  debug(message: string, properties?: Record<string, unknown>): void
  info(message: string, properties?: Record<string, unknown>): void
  warn(message: string, properties?: Record<string, unknown>): void
  error(message: string, properties?: Record<string, unknown>): void
}

/**
 * Accumulates structured fields throughout a unit of work and emits a single
 * canonical "wide event" log record at completion.
 *
 * Fields become LogTape `record.properties` -> OTEL log record attributes -> Loki labels.
 *
 * Use `event.log` for intermediate log calls that are automatically correlated
 * to this event via `event.name`:
 *
 * ```typescript
 * const ev = new WideEvent('gateway.reload', logger)
 * ev.log.info('SDL validated for {url}', { url })
 * ev.set({ 'gateway.subgraph_count': 3 })
 * ev.emit()
 * ```
 */
export class WideEvent {
  private fields: Record<string, unknown> = {}
  private readonly logger: Logger
  private readonly startTime: number
  private emitted = false
  private _log: EventLogger | null = null

  constructor(eventName: string, logger: Logger) {
    this.logger = logger
    this.startTime = performance.now()
    this.fields['event.name'] = eventName
  }

  /**
   * Logger that automatically injects `event.name` into every log call,
   * so intermediate logs can be correlated with the parent wide event.
   */
  get log(): EventLogger {
    if (!this._log) {
      const eventName = this.fields['event.name'] as string
      const logger = this.logger
      const makeCall =
        (level: 'debug' | 'info' | 'warn' | 'error') =>
        (message: string, properties?: Record<string, unknown>) => {
          logger[level](message, { 'event.name': eventName, ...properties })
        }
      this._log = {
        debug: makeCall('debug'),
        info: makeCall('info'),
        warn: makeCall('warn'),
        error: makeCall('error'),
      }
    }
    return this._log
  }

  /** Set a single field by key-value pair. */
  set(key: string, value: unknown): this
  /** Merge multiple fields from an object. */
  set(fields: Record<string, unknown>): this
  set(keyOrFields: string | Record<string, unknown>, value?: unknown): this {
    if (typeof keyOrFields === 'string') {
      this.fields[keyOrFields] = value
    } else {
      Object.assign(this.fields, keyOrFields)
    }
    return this
  }

  /**
   * Capture error information and mark the event outcome as failure.
   * Uses OTel semantic convention attributes for exceptions:
   * @see https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/
   */
  setError(error: unknown): this {
    if (error instanceof Error) {
      this.set({
        'exception.type': error.constructor.name,
        'exception.message': error.message,
        ...(error.stack ? { 'exception.stacktrace': error.stack } : {}),
        'catalyst.event.outcome': 'failure',
      })
    } else {
      this.set({
        'exception.type': typeof error,
        'exception.message': String(error),
        'catalyst.event.outcome': 'failure',
      })
    }
    return this
  }

  /** Elapsed time in milliseconds since this event was created. */
  get durationMs(): number {
    return Math.round(performance.now() - this.startTime)
  }

  /**
   * Emit the wide event as a single structured log record.
   * Computes `catalyst.event.duration_ms` and defaults `catalyst.event.outcome` to `'success'`.
   * Subsequent calls are no-ops (idempotent).
   */
  emit(): void {
    if (this.emitted) return
    this.emitted = true
    this.fields['catalyst.event.duration_ms'] = this.durationMs
    if (!('catalyst.event.outcome' in this.fields)) {
      this.fields['catalyst.event.outcome'] = 'success'
    }
    const eventName = this.fields['event.name'] as string
    const level = this.fields['catalyst.event.outcome'] === 'failure' ? 'error' : 'info'
    this.logger[level](eventName + ' completed', this.fields)
  }
}
