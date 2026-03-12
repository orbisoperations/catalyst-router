import type { Logger } from '@logtape/logtape'

/**
 * Accumulates structured fields throughout a unit of work and emits a single
 * canonical "wide event" log record at completion.
 *
 * Fields become LogTape `record.properties` -> OTEL log record attributes -> Loki labels.
 *
 * Usage:
 * ```typescript
 * const ev = new WideEvent('http.request', logger)
 * ev.set('http.request.method', 'GET')
 * ev.set({ 'url.path': '/api/health', 'http.response.status_code': 200 })
 * ev.emit()
 * ```
 */
export class WideEvent {
  private fields: Record<string, unknown> = {}
  private readonly logger: Logger
  private readonly startTime: number
  private emitted = false

  constructor(eventName: string, logger: Logger) {
    this.logger = logger
    this.startTime = performance.now()
    this.fields['event.name'] = eventName
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
