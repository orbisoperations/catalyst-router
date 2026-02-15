/**
 * @catalyst/telemetry — TelemetryBuilder
 *
 * A thin wrapper over the existing telemetry infrastructure that provides:
 * 1. A chainable builder API for per-service telemetry configuration
 * 2. A `ServiceTelemetry` context bag for dependency injection
 * 3. A synchronous `noop()` factory for unit tests
 *
 * The builder does NOT introduce new providers, exporters, or pipelines.
 * It delegates to `initTelemetry()` for global setup and creates scoped
 * instances (logger, meter, tracer) from the global registries.
 *
 * @example
 * ```ts
 * // Production — async, initializes globals
 * const telemetry = await new TelemetryBuilder('auth')
 *   .withLogger({ category: ['catalyst', 'auth'] })
 *   .withMetrics()
 *   .withTracing()
 *   .withRpcInstrumentation()
 *   .build()
 *
 * // Testing — synchronous, zero global state
 * const telemetry = TelemetryBuilder.noop('auth')
 * ```
 */

import { getLogger } from '@logtape/logtape'
import { trace, metrics } from '@opentelemetry/api'
import { initTelemetry } from './index.js'
import { instrumentRpcTarget } from './middleware/capnweb.js'
import type {
  ServiceTelemetry,
  InstrumentRpcOptions,
  LoggerBuilderOpts,
  MetricsBuilderOpts,
  TracingBuilderOpts,
  RpcBuilderOpts,
  AuthBuilderOpts,
} from './types.js'

export class TelemetryBuilder {
  private readonly _serviceName: string
  private _loggerOpts: LoggerBuilderOpts | undefined
  private _metricsOpts: MetricsBuilderOpts | undefined
  private _tracingOpts: TracingBuilderOpts | undefined
  private _rpcOpts: RpcBuilderOpts | undefined
  private _authOpts: AuthBuilderOpts | undefined

  constructor(serviceName: string) {
    if (!serviceName || !serviceName.trim()) {
      throw new Error('serviceName must be a non-empty string')
    }
    this._serviceName = serviceName
  }

  /** Configure the logger signal. Returns `this` for chaining. */
  withLogger(opts?: LoggerBuilderOpts): this {
    this._loggerOpts = opts ?? {}
    return this
  }

  /** Configure the metrics signal. Returns `this` for chaining. */
  withMetrics(opts?: MetricsBuilderOpts): this {
    this._metricsOpts = opts ?? {}
    return this
  }

  /** Configure the tracing signal. Returns `this` for chaining. */
  withTracing(opts?: TracingBuilderOpts): this {
    this._tracingOpts = opts ?? {}
    return this
  }

  /** Configure authenticated OTLP export with per-call gRPC credentials. Returns `this` for chaining. */
  withAuth(opts: AuthBuilderOpts): this {
    this._authOpts = opts
    return this
  }

  /** Configure RPC instrumentation options. Returns `this` for chaining. */
  withRpcInstrumentation(opts?: RpcBuilderOpts): this {
    this._rpcOpts = opts ?? {}
    return this
  }

  /**
   * Initialize global telemetry singletons (if not already initialized)
   * and return a scoped, frozen `ServiceTelemetry` context.
   *
   * Delegates to `initTelemetry()` which calls `configureLogger()`,
   * `configureMetrics()`, and `initTracer()` internally.
   */
  async build(): Promise<ServiceTelemetry> {
    await initTelemetry({
      serviceName: this._serviceName,
      samplingRatio: this._tracingOpts?.samplingRatio,
      tokenFn: this._authOpts?.tokenFn,
    })

    const category = this._loggerOpts?.category ?? [this._serviceName]
    const logger = getLogger(category)
    const meter = metrics.getMeter(this._serviceName)
    const tracer = trace.getTracer(this._serviceName)

    const rpcOpts = this._rpcOpts
    const serviceName = this._serviceName

    const instrumentRpc = <T extends object>(target: T, overrides?: InstrumentRpcOptions): T =>
      instrumentRpcTarget(target, {
        serviceName,
        spanKind: overrides?.spanKind ?? rpcOpts?.spanKind,
        ignoreMethods: overrides?.ignoreMethods ?? rpcOpts?.ignoreMethods,
        serverAddress: overrides?.serverAddress,
        serverPort: overrides?.serverPort,
      })

    return Object.freeze({
      serviceName: this._serviceName,
      logger,
      meter,
      tracer,
      instrumentRpc,
    })
  }

  /**
   * Synchronously return a `ServiceTelemetry` with noop implementations.
   * Does NOT modify any global state — safe for unit tests.
   *
   * **Important**: If a real `.build()` has already registered global OTel
   * providers in the same process, the meter and tracer returned here will
   * NOT be true noops. Never mix `.build()` and `.noop()` in the same
   * test file. See test-strategy.md for the isolation approach.
   */
  static noop(serviceName: string): ServiceTelemetry {
    return Object.freeze({
      serviceName,
      logger: getLogger([serviceName]),
      meter: metrics.getMeter(serviceName),
      tracer: trace.getTracer(serviceName),
      instrumentRpc: <T extends object>(target: T): T => target,
    })
  }
}
