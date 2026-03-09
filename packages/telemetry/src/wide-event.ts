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
 * ev.set('http.method', 'GET')
 * ev.set({ 'http.path': '/api/health', 'http.status': 200 })
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
   * Handles both Error instances and arbitrary thrown values.
   */
  setError(error: unknown): this {
    if (error instanceof Error) {
      this.set({
        'error.type': error.constructor.name,
        'error.message': error.message,
        'event.outcome': 'failure',
      })
    } else {
      this.set({
        'error.type': typeof error,
        'error.message': String(error),
        'event.outcome': 'failure',
      })
    }
    return this
  }

  /**
   * Emit the wide event as a single structured log record.
   * Computes `event.duration_ms` and defaults `event.outcome` to `'success'`.
   * Subsequent calls are no-ops (idempotent).
   */
  emit(): void {
    if (this.emitted) return
    this.emitted = true
    this.fields['event.duration_ms'] = Math.round(performance.now() - this.startTime)
    if (!this.fields['event.outcome']) {
      this.fields['event.outcome'] = 'success'
    }
    const eventName = this.fields['event.name'] as string
    const level = this.fields['event.outcome'] === 'failure' ? 'error' : 'info'
    this.logger[level](eventName + ' completed', this.fields)
  }
}
