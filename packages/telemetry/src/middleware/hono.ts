/**
 * @catalyst/telemetry — Hono telemetry middleware
 *
 * Auto-creates a span per HTTP request with method, route, status, and duration.
 * Extracts inbound W3C traceparent for distributed trace propagation.
 *
 * Follows stable HTTP semantic conventions (v1.23.0+):
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-spans/
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/http/
 *
 * Span naming follows the {method} {route} convention:
 * @see https://opentelemetry.io/blog/2025/how-to-name-your-spans/
 */

import { type Context, type MiddlewareHandler } from 'hono'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions'
import { normalizePath } from '../normalize'
import type { MiddlewareOptions } from '../types'

/**
 * Hono middleware that instruments every HTTP request with an OpenTelemetry span.
 *
 * - Creates a span named `{prefix} {METHOD} {route}` (prefix defaults to "HTTP")
 * - Records stable semconv attributes: `http.request.method`, `http.route`,
 *   `http.response.status_code`, `url.path`
 * - Extracts inbound `traceparent` header for distributed trace propagation
 * - Skips instrumentation for paths listed in `ignorePaths` (exact match)
 */
export function telemetryMiddleware(options?: MiddlewareOptions): MiddlewareHandler {
  const ignorePaths = new Set(options?.ignorePaths ?? [])
  const prefix = options?.spanNamePrefix ?? 'HTTP'

  return async (c: Context, next: () => Promise<void>) => {
    const path = c.req.path

    if (ignorePaths.has(path)) {
      return next()
    }

    // Extract only W3C propagation headers (traceparent, tracestate)
    // WHY not all headers: Copying the entire header map per request adds
    // unnecessary GC pressure. W3C propagation only needs these two.
    const inboundHeaders: Record<string, string> = {}
    const tp = c.req.header('traceparent')
    if (tp) inboundHeaders['traceparent'] = tp
    const ts = c.req.header('tracestate')
    if (ts) inboundHeaders['tracestate'] = ts
    const parentCtx = propagation.extract(context.active(), inboundHeaders)

    const tracer = trace.getTracer('@catalyst/telemetry')

    return context.with(parentCtx, async () => {
      // Start span with a temporary name; updated after route matching
      const span = tracer.startSpan(`${prefix} ${c.req.method} ${path}`, {}, context.active())

      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, c.req.method)
      span.setAttribute(ATTR_URL_PATH, path)

      try {
        await context.with(trace.setSpan(context.active(), span), async () => {
          await next()
        })
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        // After next(), Hono has matched the route and set routePath.
        // Fallback to normalizePath() for unmatched routes (e.g. 404)
        // to avoid high-cardinality span names from raw paths.
        // See: https://github.com/open-telemetry/opentelemetry-specification/issues/3534
        const rawRoute = c.req.routePath ?? '/*'
        const routePattern = rawRoute !== '/*' ? rawRoute : normalizePath(path)
        span.updateName(`${prefix} ${c.req.method} ${routePattern}`)
        span.setAttribute(ATTR_HTTP_ROUTE, routePattern)

        const status = c.res.status
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status)

        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR })
        }

        span.end()
      }
    })
  }
}
