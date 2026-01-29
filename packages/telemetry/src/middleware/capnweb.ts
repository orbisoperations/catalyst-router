/**
 * @catalyst/telemetry — capnweb RPC instrumentation
 *
 * Wraps RpcTarget instances with a Proxy to automatically create spans
 * for each RPC method call. Since capnweb v0.4.0 has no middleware hooks,
 * this uses JavaScript Proxy to intercept method calls.
 *
 * WHY Proxy instead of class extension:
 * - Services already extend RpcTarget (CatalystNodeBus, AuthRpcServer, etc.)
 * - publicApi() returns a plain object, not the RpcTarget itself
 * - Proxy wraps at the HTTP boundary, keeping telemetry decoupled from RPC logic
 * - No change required to existing RpcTarget subclasses
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
 */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { sanitizeAttributes } from '../sanitizers'

// RPC semconv attributes (not yet stable/exported from @opentelemetry/semantic-conventions)
const ATTR_RPC_SYSTEM_NAME = 'rpc.system.name'
const ATTR_RPC_METHOD = 'rpc.method'
const ATTR_ERROR_TYPE = 'error.type'

// Custom attributes (catalyst-specific, not in OTEL semconv)
const ATTR_CATALYST_RPC_REQUEST_ARGS = 'catalyst.rpc.request.args'
const ATTR_CATALYST_RPC_RESPONSE_ERROR = 'catalyst.rpc.response.error'

/**
 * Methods to skip instrumentation for (internal RpcTarget methods).
 */
const SKIP_METHODS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'toJSON',
  // capnweb internal methods
  '_handleMessage',
  '_sendMessage',
  '_serialize',
  '_deserialize',
])

/**
 * Options for instrumentRpcTarget.
 */
export interface RpcInstrumentationOptions {
  /** Service name for span attributes. Defaults to 'rpc'. */
  serviceName?: string

  /** Method names to skip instrumentation for. */
  ignoreMethods?: string[]

  /**
   * Whether to record method arguments as span attributes. Defaults to false.
   * WHY opt-in: RPC args may contain sensitive data. When enabled, args are
   * passed through sanitizeAttributes() to redact passwords/tokens.
   */
  recordArguments?: boolean
}

/**
 * Wraps an RpcTarget instance with OpenTelemetry instrumentation.
 *
 * Creates a span for each public method call with RPC semantic conventions:
 * - `rpc.system.name`: 'capnweb'
 * - `rpc.method`: service/method name
 *
 * @example
 * ```typescript
 * const bus = new CatalystNodeBus({ ... })
 * const instrumented = instrumentRpcTarget(bus.publicApi(), {
 *   serviceName: 'orchestrator'
 * })
 *
 * app.all('/rpc', (c) => {
 *   return newRpcResponse(c, instrumented, { upgradeWebSocket })
 * })
 * ```
 */
export function instrumentRpcTarget<T extends object>(
  target: T,
  options?: RpcInstrumentationOptions
): T {
  const serviceName = options?.serviceName ?? 'rpc'
  const ignoreMethods = new Set([...SKIP_METHODS, ...(options?.ignoreMethods ?? [])])
  const recordArguments = options?.recordArguments ?? false

  const tracer = trace.getTracer('@catalyst/telemetry')

  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver)

      // Skip non-functions and internal methods
      if (typeof value !== 'function') {
        return value
      }

      const methodName = String(prop)

      // Skip internal/ignored methods
      if (methodName.startsWith('_') || ignoreMethods.has(methodName)) {
        return value
      }

      // Return instrumented wrapper
      return async function instrumentedMethod(...args: unknown[]) {
        const rpcMethod = `${serviceName}/${methodName}`

        // WHY SpanKind.SERVER: Per OTEL spec, server-side RPC spans MUST have
        // kind SERVER. This enables correct topology rendering in tracing UIs.
        return tracer.startActiveSpan(rpcMethod, { kind: SpanKind.SERVER }, async (span) => {
          // Set RPC semantic convention attributes
          span.setAttribute(ATTR_RPC_SYSTEM_NAME, 'capnweb')
          span.setAttribute(ATTR_RPC_METHOD, rpcMethod)

          // Optionally record sanitized arguments
          if (recordArguments && args.length > 0) {
            try {
              const sanitized = sanitizeAttributes({ args })
              span.setAttribute(ATTR_CATALYST_RPC_REQUEST_ARGS, JSON.stringify(sanitized.args))
            } catch {
              // Ignore serialization errors
            }
          }

          try {
            const result = await value.apply(obj, args)

            // WHY check for { success: false } and { valid: false }: capnweb methods
            // return result objects instead of throwing. Most use { success: false, error }
            // but verifyToken uses { valid: false, error } as its discriminator.
            const isErrorResult =
              result &&
              typeof result === 'object' &&
              'error' in result &&
              (('success' in result && !result.success) || ('valid' in result && !result.valid))

            if (result && typeof result === 'object' && ('success' in result || 'valid' in result)) {
              if (isErrorResult) {
                span.setAttribute(ATTR_ERROR_TYPE, 'RpcError')
                span.setAttribute(ATTR_CATALYST_RPC_RESPONSE_ERROR, String(result.error))
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(result.error),
                })
              } else {
                span.setStatus({ code: SpanStatusCode.OK })
              }
            } else {
              span.setStatus({ code: SpanStatusCode.OK })
            }

            return result
          } catch (err) {
            const errorType = err instanceof Error ? err.constructor.name : 'Error'
            span.setAttribute(ATTR_ERROR_TYPE, errorType)
            span.recordException(err as Error)
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            })
            throw err
          } finally {
            span.end()
          }
        })
      }
    },
  })
}

/**
 * Creates an instrumented version of an RpcTarget's public API.
 *
 * This is a convenience wrapper for services that expose a publicApi() method.
 *
 * @example
 * ```typescript
 * const bus = new CatalystNodeBus({ ... })
 *
 * app.all('/rpc', (c) => {
 *   return newRpcResponse(c, instrumentPublicApi(bus, 'orchestrator'), {
 *     upgradeWebSocket,
 *   })
 * })
 * ```
 */
export function instrumentPublicApi<T extends { publicApi(): object }>(
  target: T,
  serviceName?: string
): ReturnType<T['publicApi']> {
  return instrumentRpcTarget(target.publicApi(), { serviceName }) as ReturnType<T['publicApi']>
}
