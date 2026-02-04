/**
 * capnweb RPC instrumentation via Proxy
 *
 * Wraps RPC target objects so each method call gets an OTEL span.
 * capnweb v0.4 has no middleware hooks, so we intercept at the JS level:
 * a Proxy sits between capnweb's deserialization layer and the real target,
 * creating spans for every inbound RPC method call.
 *
 * Supports both server-side (inbound) and client-side (outbound) instrumentation
 * via the `spanKind` option. Transport-level trace context propagation is
 * handled by capnweb-transport.ts.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
 */

import {
  SpanKind,
  SpanStatusCode,
  trace,
  context as otelContext,
  metrics,
} from '@opentelemetry/api'
import type { Attributes, Histogram } from '@opentelemetry/api'
import { DURATION_BUCKETS } from '../constants.js'

const ATTR_RPC_SYSTEM_NAME = 'rpc.system.name'
const ATTR_RPC_METHOD = 'rpc.method'
const ATTR_ERROR_TYPE = 'error.type'
const ATTR_CATALYST_RPC_RESPONSE_ERROR = 'catalyst.rpc.response.error'
const ATTR_NETWORK_TRANSPORT = 'network.transport'
const ATTR_NETWORK_PROTOCOL_NAME = 'network.protocol.name'
const ATTR_SERVER_ADDRESS = 'server.address'
const ATTR_SERVER_PORT = 'server.port'
const ATTR_CLIENT_ADDRESS = 'client.address'
const ATTR_CLIENT_PORT = 'client.port'

/** Connection info propagated via OTEL context from the transport layer. */
export interface RpcConnectionInfo {
  address?: string
  port?: number
}

/**
 * OTEL context key for client connection info.
 * Set by instrumentUpgradeWebSocket, read by instrumentRpcTarget for SERVER spans.
 */
export const RPC_CLIENT_INFO_KEY = Symbol.for('catalyst.rpc.client-info')

// RPC duration metric names per OTEL RPC semconv
const METRIC_RPC_SERVER_DURATION = 'rpc.server.duration'
const METRIC_RPC_CLIENT_DURATION = 'rpc.client.duration'

let serverDurationHistogram: Histogram | null = null
let clientDurationHistogram: Histogram | null = null

function getServerDurationHistogram(): Histogram {
  if (!serverDurationHistogram) {
    const meter = metrics.getMeter('@catalyst/telemetry')
    serverDurationHistogram = meter.createHistogram(METRIC_RPC_SERVER_DURATION, {
      description: 'Duration of inbound RPC calls',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    })
  }
  return serverDurationHistogram
}

function getClientDurationHistogram(): Histogram {
  if (!clientDurationHistogram) {
    const meter = metrics.getMeter('@catalyst/telemetry')
    clientDurationHistogram = meter.createHistogram(METRIC_RPC_CLIENT_DURATION, {
      description: 'Duration of outbound RPC calls',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    })
  }
  return clientDurationHistogram
}

/** Reset cached histograms after metrics provider shutdown/reconfigure. */
export function _resetRpcMetricsCache(): void {
  serverDurationHistogram = null
  clientDurationHistogram = null
}

const SKIP_METHODS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'toJSON',
  '_handleMessage',
  '_sendMessage',
  '_serialize',
  '_deserialize',
])

export interface RpcInstrumentationOptions {
  /** Service name for span attributes. Defaults to 'rpc'. */
  serviceName?: string
  /** Method names to skip instrumentation for. */
  ignoreMethods?: string[]
  /** Span kind: 'CLIENT' for outbound stubs, 'SERVER' for inbound targets. Defaults to 'SERVER'. */
  spanKind?: 'CLIENT' | 'SERVER'
  /** Remote server hostname or IP. Populates server.address on CLIENT spans. */
  serverAddress?: string
  /** Remote server port. Populates server.port on CLIENT spans. */
  serverPort?: number
}

/**
 * Wraps an object with a Proxy that creates OTEL spans for each method call.
 *
 * Designed for capnweb RPC targets — pass the result to `newRpcResponse()`
 * or `createRpcHandler()` in place of the original target.
 */
export function instrumentRpcTarget<T extends object>(
  target: T,
  options?: RpcInstrumentationOptions
): T {
  const serviceName = options?.serviceName ?? 'rpc'
  const ignoreMethods = new Set([...SKIP_METHODS, ...(options?.ignoreMethods ?? [])])
  const kind = options?.spanKind === 'CLIENT' ? SpanKind.CLIENT : SpanKind.SERVER
  const tracer = trace.getTracer('@catalyst/telemetry')

  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)

      if (typeof value !== 'function') return value

      const methodName = String(prop)
      if (methodName.startsWith('_') || ignoreMethods.has(methodName)) return value

      return function instrumentedMethod(...args: unknown[]) {
        const rpcMethod = `${serviceName}/${methodName}`

        const attributes: Attributes = {
          [ATTR_RPC_SYSTEM_NAME]: 'capnweb',
          [ATTR_RPC_METHOD]: rpcMethod,
          [ATTR_NETWORK_TRANSPORT]: 'tcp',
          [ATTR_NETWORK_PROTOCOL_NAME]: 'websocket',
        }

        if (kind === SpanKind.CLIENT) {
          if (options?.serverAddress) attributes[ATTR_SERVER_ADDRESS] = options.serverAddress
          if (options?.serverPort) attributes[ATTR_SERVER_PORT] = options.serverPort
        } else {
          const clientInfo = otelContext.active().getValue(RPC_CLIENT_INFO_KEY) as
            | RpcConnectionInfo
            | undefined
          if (clientInfo?.address) attributes[ATTR_CLIENT_ADDRESS] = clientInfo.address
          if (clientInfo?.port) attributes[ATTR_CLIENT_PORT] = clientInfo.port
        }

        const histogram =
          kind === SpanKind.CLIENT ? getClientDurationHistogram() : getServerDurationHistogram()
        const startTime = performance.now()

        const recordDuration = (metricAttrs: Attributes) => {
          const durationSeconds = (performance.now() - startTime) / 1000
          histogram.record(durationSeconds, metricAttrs)
        }

        return tracer.startActiveSpan(rpcMethod, { kind, attributes }, (span) => {
          const metricAttrs: Attributes = {
            [ATTR_RPC_SYSTEM_NAME]: 'capnweb',
            [ATTR_RPC_METHOD]: rpcMethod,
          }

          const finalizeResult = (result: unknown) => {
            // Detect capnweb-style error responses: { success: false, error } or { valid: false, error }
            const isErrorResult =
              result &&
              typeof result === 'object' &&
              'error' in result &&
              (('success' in result && !result.success) || ('valid' in result && !result.valid))

            if (isErrorResult) {
              span.setAttribute(ATTR_ERROR_TYPE, 'RpcError')
              span.setAttribute(
                ATTR_CATALYST_RPC_RESPONSE_ERROR,
                String((result as { error: unknown }).error)
              )
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String((result as { error: unknown }).error),
              })
              metricAttrs[ATTR_ERROR_TYPE] = 'RpcError'
            }
          }

          try {
            const result = Reflect.apply(value, obj, args)
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              return (result as Promise<unknown>)
                .then((resolved) => {
                  finalizeResult(resolved)
                  return resolved
                })
                .catch((err) => {
                  const errorType = err instanceof Error ? err.constructor.name : 'Error'
                  span.setAttribute(ATTR_ERROR_TYPE, errorType)
                  span.recordException(err as Error)
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err instanceof Error ? err.message : String(err),
                  })
                  metricAttrs[ATTR_ERROR_TYPE] = errorType
                  throw err
                })
                .finally(() => {
                  span.end()
                  recordDuration(metricAttrs)
                })
            }

            finalizeResult(result)
            span.end()
            recordDuration(metricAttrs)
            return result
          } catch (err) {
            const errorType = err instanceof Error ? err.constructor.name : 'Error'
            span.setAttribute(ATTR_ERROR_TYPE, errorType)
            span.recordException(err as Error)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            })
            metricAttrs[ATTR_ERROR_TYPE] = errorType
            span.end()
            recordDuration(metricAttrs)
            throw err
          }
        })
      }
    },
  })
}

/**
 * Convenience wrapper for services that expose a `publicApi()` method.
 *
 * ```typescript
 * const bus = new CatalystNodeBus({ ... })
 * const instrumented = instrumentPublicApi(bus, 'orchestrator')
 * newRpcResponse(c, instrumented, { upgradeWebSocket })
 * ```
 */
export function instrumentPublicApi<T extends { publicApi(): object }>(
  target: T,
  serviceName?: string
): ReturnType<T['publicApi']> {
  return instrumentRpcTarget(target.publicApi(), { serviceName }) as ReturnType<T['publicApi']>
}
