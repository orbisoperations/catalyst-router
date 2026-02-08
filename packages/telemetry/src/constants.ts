/**
 * @catalyst/telemetry — Shared constants
 *
 * Centralizes configuration values used across multiple telemetry modules
 * to keep them consistent and easy to change.
 */

/**
 * OTEL semconv recommended bucket boundaries for latency histograms (seconds).
 * Used by both HTTP and RPC duration metrics.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]

/** Timeout for OTLP exporters (traces, metrics) in milliseconds. */
export const EXPORT_TIMEOUT_MS = 10_000

/** Fallback service name when none is provided via config or env. */
export const DEFAULT_SERVICE_NAME = 'catalyst'

// ---------------------------------------------------------------------------
// Environment validation helpers
// ---------------------------------------------------------------------------

export const VALID_LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const
export type LogLevel = (typeof VALID_LOG_LEVELS)[number]

export const VALID_ENVIRONMENTS = ['development', 'production', 'test'] as const
export type Environment = (typeof VALID_ENVIRONMENTS)[number]

export function validateLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined
  if ((VALID_LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel
  console.warn(`[telemetry] invalid LOG_LEVEL "${value}", defaulting to "info"`)
  return undefined
}

export function validateEnvironment(value: string | undefined): Environment | undefined {
  if (!value) return undefined
  if ((VALID_ENVIRONMENTS as readonly string[]).includes(value)) return value as Environment
  console.warn(`[telemetry] invalid NODE_ENV "${value}", defaulting to "development"`)
  return undefined
}
