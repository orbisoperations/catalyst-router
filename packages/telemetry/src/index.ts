/**
 * @catalyst/telemetry — Public API
 *
 * Unified entry point for OpenTelemetry traces, metrics, and logs.
 * Single-call init orchestrates all providers; shutdown flushes everything.
 */

import type { SpanExporter } from '@opentelemetry/sdk-trace-node'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { initTracer, shutdownTracer } from './tracer'
import { initMeter, shutdownMeter } from './meter'
import { initLogger, shutdownLogger } from './logger'
import type { TelemetryOptions } from './types'

interface InitOptions extends TelemetryOptions {
  /** @internal Test-only: inject an in-memory span exporter */
  _testSpanExporter?: SpanExporter
  /** @internal Test-only: inject an in-memory metric exporter */
  _testMetricExporter?: PushMetricExporter
  /** @internal Test-only: inject a pre-configured LoggerProvider */
  _testLoggerProvider?: LoggerProvider
}

/**
 * WHY a state machine: A dual-flag approach (`initPromise` + `initialized`)
 * is racy — shutdown() could run while performInit() is in-flight, see
 * `initialized = false`, and no-op. Then init completes and the system
 * believes it's ready but shutdown already ran. A single state variable
 * with explicit transitions prevents this class of bugs.
 */
type TelemetryState = 'idle' | 'initializing' | 'ready' | 'shutting_down'
let state: TelemetryState = 'idle'
let initPromise: Promise<void> | null = null

/**
 * Initialize all telemetry providers (tracer, meter, logger) in one call.
 * Safe to call multiple times — subsequent calls warn and no-op.
 * Concurrent calls are serialized via a shared promise.
 */
export function initTelemetry(opts: InitOptions): Promise<void> {
  if (!opts.serviceName || opts.serviceName.trim() === '') {
    throw new Error('[telemetry] serviceName is required and must be non-empty')
  }

  if (state !== 'idle') {
    console.warn('[telemetry] Already initialized, ignoring duplicate initTelemetry call')
    return initPromise ?? Promise.resolve()
  }
  state = 'initializing'
  initPromise = performInit(opts)
  return initPromise
}

async function performInit(opts: InitOptions): Promise<void> {
  try {
    initTracer({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion,
      environment: opts.environment,
      otlpEndpoint: opts.otlpEndpoint,
      batch: opts.batch,
      _testExporter: opts._testSpanExporter,
    })

    initMeter({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion,
      environment: opts.environment,
      otlpEndpoint: opts.otlpEndpoint,
      batch: opts.metricExportIntervalMillis
        ? { exportIntervalMillis: opts.metricExportIntervalMillis }
        : undefined,
      _testExporter: opts._testMetricExporter,
    })

    await initLogger({
      loggerProvider: opts._testLoggerProvider,
      logLevel: opts.logLevel,
      enableConsole: opts.enableConsole,
    })

    state = 'ready'
  } catch (err) {
    state = 'idle'
    initPromise = null
    await Promise.allSettled([shutdownTracer(), shutdownMeter()])
    throw err
  }
}

/**
 * Gracefully shutdown all telemetry providers, flushing pending data.
 * Safe to call multiple times. If init is in-flight, waits for it
 * to complete before shutting down.
 */
export async function shutdown(): Promise<void> {
  if (state === 'idle' || state === 'shutting_down') return

  // If init is still in-flight, wait for it to finish first
  if (state === 'initializing' && initPromise) {
    try {
      await initPromise
    } catch {
      // Init failed — it already cleaned up; nothing to shut down
      return
    }
  }

  state = 'shutting_down'

  const results = await Promise.allSettled([shutdownTracer(), shutdownMeter(), shutdownLogger()])
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[telemetry] Shutdown error:', r.reason)
    }
  }

  state = 'idle'
  initPromise = null
}

// Re-export provider accessors
export { getTracer } from './tracer'
export { getMeter } from './meter'
export { getLogger } from './logger'

// Re-export utilities
export { sanitizeAttributes } from './sanitizers'
export { normalizePath } from './normalize'

// Re-export propagation helpers
export { injectTraceHeaders, extractTraceContext, getTraceId, getSpanId } from './propagation/w3c'

// Re-export types
export type {
  TelemetryOptions,
  BatchConfig,
  MiddlewareOptions,
  Tracer,
  Meter,
  Span,
  Counter,
  Histogram,
  ObservableGauge,
  Logger,
} from './types'
export { SpanStatusCode } from './types'
