/**
 * @catalyst/telemetry — Shared type definitions
 *
 * Defines the ServiceTelemetry interface (the DI contract) and
 * builder option types used by TelemetryBuilder.
 */

import type { Logger } from '@logtape/logtape'
import type { Meter, Tracer } from '@opentelemetry/api'
import type { LogLevel } from './constants.js'

// ---------------------------------------------------------------------------
// ServiceTelemetry — the DI contract
// ---------------------------------------------------------------------------

/** Options for per-call RPC instrumentation overrides. */
export interface InstrumentRpcOptions {
  /** Span kind: 'CLIENT' for outbound stubs, 'SERVER' for inbound targets. */
  spanKind?: 'CLIENT' | 'SERVER'
  /** Method names to skip instrumentation for. */
  ignoreMethods?: string[]
  /** Remote server hostname or IP (CLIENT spans). */
  serverAddress?: string
  /** Remote server port (CLIENT spans). */
  serverPort?: number
}

/**
 * Immutable telemetry context bag injected into service constructors.
 *
 * Produced by `TelemetryBuilder.build()` or `TelemetryBuilder.noop()`.
 * The object is frozen after creation — fields cannot be reassigned.
 */
export interface ServiceTelemetry {
  /** Service name used for scoping logger categories, meter names, and tracer names. */
  readonly serviceName: string
  /** Scoped LogTape logger. Uses tagged template literal API. */
  readonly logger: Logger
  /** Scoped OpenTelemetry meter for creating counters, histograms, etc. */
  readonly meter: Meter
  /** Scoped OpenTelemetry tracer for creating spans. */
  readonly tracer: Tracer
  /**
   * Wraps an RPC target with tracing instrumentation.
   * Pre-configured with the builder's serviceName and RPC options.
   * Noop variant returns the target unchanged.
   */
  readonly instrumentRpc: <T extends object>(target: T, opts?: InstrumentRpcOptions) => T
}

// ---------------------------------------------------------------------------
// Builder option types
// ---------------------------------------------------------------------------

/** Options for `.withLogger()`. */
export interface LoggerBuilderOpts {
  /** Log level threshold. Defaults to LOG_LEVEL env var or 'info'. */
  level?: LogLevel
  /** Logger category hierarchy. Defaults to [serviceName]. */
  category?: string[]
}

/** Options for `.withMetrics()`. */
export interface MetricsBuilderOpts {
  /** Metric export interval in milliseconds. Defaults to 60_000. */
  exportIntervalMs?: number
}

/** Options for `.withTracing()`. */
export interface TracingBuilderOpts {
  /** Trace sampling ratio (0.0 to 1.0). Defaults to env or auto. */
  samplingRatio?: number
}

/** Options for `.withRpcInstrumentation()`. */
export interface RpcBuilderOpts {
  /** Default span kind for RPC instrumentation. Defaults to 'SERVER'. */
  spanKind?: 'CLIENT' | 'SERVER'
  /** Method names to skip instrumentation for. */
  ignoreMethods?: string[]
}
