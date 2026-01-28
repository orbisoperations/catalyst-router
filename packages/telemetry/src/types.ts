/**
 * @catalyst/telemetry — Type definitions and re-exports
 *
 * Central type definitions for the telemetry package.
 * Re-exports OTEL and LogTape types so consumers don't need direct deps.
 */

// Re-export OTEL types consumers need
export type { Tracer, Meter, Span, Counter, Histogram, ObservableGauge } from '@opentelemetry/api'
export { SpanStatusCode } from '@opentelemetry/api'

// Re-export LogTape Logger type
export type { Logger } from '@logtape/logtape'

/**
 * Configuration for `initTelemetry()`.
 */
export interface TelemetryOptions {
  /** Service name used as OTEL resource attribute `service.name`. Required. */
  serviceName: string

  /** Service version used as OTEL resource attribute `service.version`. Defaults to "0.0.0". */
  serviceVersion?: string

  /** Deployment environment used as OTEL resource attribute `deployment.environment`. Defaults to "development". */
  environment?: string

  /** OTLP HTTP endpoint for exporting telemetry. Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env var or "http://localhost:4318". */
  otlpEndpoint?: string

  /** Minimum log level. Defaults to "info". */
  logLevel?: 'debug' | 'info' | 'warning' | 'error' | 'fatal'

  /** Enable console sink for logs. Defaults to true. */
  enableConsole?: boolean

  /** Custom batch processor configuration for trace spans. */
  batch?: BatchConfig

  /** Custom export interval for metrics (separate from trace batch config). */
  metricExportIntervalMillis?: number
}

/**
 * Configuration for BatchSpanProcessor.
 *
 * Trace batching controls how spans are queued and flushed.
 * Metric export interval is configured separately via `metricExportIntervalMillis`
 * on `TelemetryOptions`, since metrics use a periodic reader with different
 * semantics and a different default interval (60s vs 5s for traces).
 */
export interface BatchConfig {
  /** Maximum number of spans in the export queue. Defaults to 2048. */
  maxQueueSize?: number

  /** Maximum batch size per export. Defaults to 512. */
  maxExportBatchSize?: number

  /** Delay between span batch exports in milliseconds. Defaults to 5000. */
  scheduledDelayMillis?: number
}

/**
 * Options for `telemetryMiddleware()`.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-spans/ — HTTP span conventions
 */
export interface MiddlewareOptions {
  /** Paths to skip instrumentation for (e.g., ["/health", "/ready"]). Exact match only. */
  ignorePaths?: string[]

  /** Custom span name prefix. Defaults to "HTTP". */
  spanNamePrefix?: string
}
