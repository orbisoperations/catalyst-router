import type { ChannelCredentials as GrpcChannelCredentials } from '@grpc/grpc-js'
import { configureLogger, shutdownLogger, resetLogger, getLogger } from './logger.js'
import type { LoggerConfig } from './logger.js'
import { configureMetrics, shutdownMetrics, getMeter } from './metrics.js'
import type { MetricsConfig } from './metrics.js'
import { initTracer, getTracer, shutdownTracer } from './instrumentation.js'
import type { TracerConfig } from './instrumentation.js'

// ---------------------------------------------------------------------------
// Per-signal API (advanced / testing — prefer initTelemetry + shutdownTelemetry)
// ---------------------------------------------------------------------------
export { configureLogger, shutdownLogger, getLogger }
/** @internal Reset all logger state. For test teardown only. */
export { resetLogger }
export type { LoggerConfig }
export { configureMetrics, shutdownMetrics, getMeter }
export type { MetricsConfig }
export { initTracer, getTracer, shutdownTracer }
export type { TracerConfig }

// ---------------------------------------------------------------------------
// capnweb RPC instrumentation
// ---------------------------------------------------------------------------
export {
  instrumentRpcTarget,
  instrumentPublicApi,
  RPC_CLIENT_INFO_KEY,
} from './middleware/capnweb.js'
/** @internal Reset cached RPC metrics instruments. For test teardown only. */
export { _resetRpcMetricsCache } from './middleware/capnweb.js'
export type { RpcInstrumentationOptions, RpcConnectionInfo } from './middleware/capnweb.js'

// ---------------------------------------------------------------------------
// capnweb transport-level trace propagation (WebSocket)
// ---------------------------------------------------------------------------
export {
  instrumentUpgradeWebSocket,
  createTracePropagatingTransport,
  WebSocketTransportAdapter,
  extractTraceEnvelope,
  withTraceContext,
} from './middleware/capnweb-transport.js'
export type { InstrumentUpgradeOptions } from './middleware/capnweb-transport.js'

// Hono middleware is available via the subpath '@catalyst/telemetry/middleware/hono'
// to avoid requiring hono for consumers that only need logs/metrics/tracing.

// ---------------------------------------------------------------------------
// Builder + DI
// ---------------------------------------------------------------------------
export { TelemetryBuilder } from './builder.js'
export type { ServiceTelemetry, InstrumentRpcOptions, AuthBuilderOpts } from './types.js'

// ---------------------------------------------------------------------------
// Unified init / shutdown
// ---------------------------------------------------------------------------

export interface TelemetryInitOptions {
  serviceName: string
  serviceVersion?: string
  environment?: LoggerConfig['environment']
  otlpEndpoint?: string
  samplingRatio?: number
  serviceInstanceId?: string
  /** Per-call gRPC credential injection for authenticated OTLP export. */
  tokenFn?: () => string
}

/**
 * Single entry point that initializes all three telemetry signals:
 * traces, metrics, and logs.
 *
 * Replaces the previous 3-step pattern:
 *   import '@catalyst/telemetry/instrumentation'
 *   await configureLogger()
 *   configureMetrics({ serviceName })
 */
export async function initTelemetry(opts: TelemetryInitOptions): Promise<void> {
  try {
    // Build gRPC credentials if tokenFn is provided
    let credentials: GrpcChannelCredentials | undefined
    if (opts.tokenFn) {
      const grpc = await import('@grpc/grpc-js')
      const tokenFn = opts.tokenFn
      const callCredentials = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
        const meta = new grpc.Metadata()
        meta.set('authorization', `Bearer ${tokenFn()}`)
        cb(null, meta)
      })
      credentials = grpc.credentials.combineChannelCredentials(
        grpc.credentials.createInsecure(),
        callCredentials
      )
    }

    initTracer({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion,
      environment: opts.environment,
      otlpEndpoint: opts.otlpEndpoint,
      samplingRatio: opts.samplingRatio,
      serviceInstanceId: opts.serviceInstanceId,
      credentials,
    })

    await configureLogger({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion,
      environment: opts.environment as LoggerConfig['environment'],
      otlpEndpoint: opts.otlpEndpoint,
      serviceInstanceId: opts.serviceInstanceId,
      credentials,
    })

    configureMetrics({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion,
      environment: opts.environment,
      otlpEndpoint: opts.otlpEndpoint,
      serviceInstanceId: opts.serviceInstanceId,
      credentials,
    })
  } catch (err) {
    // Roll back any already-initialized subsystems
    await Promise.allSettled([shutdownTracer(), shutdownLogger(), shutdownMetrics()])
    throw err
  }
}

/**
 * Gracefully shut down all telemetry subsystems in parallel.
 *
 * Also resets the HTTP middleware histogram cache so that reconfiguring
 * metrics after shutdown picks up the new meter provider.
 *
 * If you call shutdownMetrics() directly instead of shutdownTelemetry(),
 * also call _resetMiddlewareCache() before reconfiguring.
 */
export async function shutdownTelemetry(): Promise<void> {
  // Reset RPC metrics cache (always available — no optional dep)
  const { _resetRpcMetricsCache: resetRpc } = await import('./middleware/capnweb.js')
  resetRpc()

  // Dynamic import avoids eagerly loading hono for non-middleware consumers.
  // If hono isn't installed, skip cache reset rather than throwing on shutdown.
  try {
    const { _resetMiddlewareCache } = await import('./middleware/hono.js')
    _resetMiddlewareCache()
  } catch {
    // ignore missing optional dependency
  }
  const SHUTDOWN_TIMEOUT_MS = 10_000
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('telemetry shutdown timed out')),
      SHUTDOWN_TIMEOUT_MS
    )
  })

  let results: PromiseSettledResult<void>[] = []
  try {
    results = await Promise.race([
      Promise.allSettled([resetLogger(), shutdownMetrics(), shutdownTracer()]),
      deadline,
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[telemetry] shutdown timed out:', message)
    results = []
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[telemetry] shutdown failed:', result.reason)
    }
  }
}
