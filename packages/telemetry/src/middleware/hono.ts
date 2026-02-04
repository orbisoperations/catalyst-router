/**
 * @catalyst/telemetry — Hono telemetry middleware
 *
 * Auto-creates a span per HTTP request with method, route, status, and duration.
 * Records HTTP server metrics (request duration histogram).
 * Extracts inbound W3C traceparent for distributed trace propagation.
 *
 * Follows stable HTTP semantic conventions (v1.23.0+):
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-spans/
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 */

import { type Context, type MiddlewareHandler } from 'hono'
import { routePath as getRoutePath } from 'hono/route'
import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import { DURATION_BUCKETS } from '../constants.js'

export interface MiddlewareOptions {
  /** Paths to skip instrumentation for (e.g., ["/health", "/ready"]). Exact match. */
  ignorePaths?: string[]
  /** Custom span name prefix. Defaults to "HTTP". */
  spanNamePrefix?: string
}

// Metric name per OTEL HTTP semconv
const METRIC_HTTP_SERVER_REQUEST_DURATION = 'http.server.request.duration'

let durationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null =
  null

export function _resetMiddlewareCache(): void {
  durationHistogram = null
}

function getDurationHistogram() {
  if (!durationHistogram) {
    const meter = metrics.getMeter('@catalyst/telemetry')
    durationHistogram = meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
      description: 'Duration of HTTP server requests',
      unit: 's',
      advice: {
        explicitBucketBoundaries: DURATION_BUCKETS,
      },
    })
  }
  return durationHistogram
}

export function telemetryMiddleware(
  options?: MiddlewareOptions | (() => MiddlewareOptions)
): MiddlewareHandler {
  const staticOptions = typeof options === 'function' ? null : (options ?? {})
  const getOptions = typeof options === 'function' ? options : () => staticOptions ?? {}
  const staticIgnorePaths = staticOptions ? new Set(staticOptions.ignorePaths ?? []) : null

  return async (c: Context, next: () => Promise<void>) => {
    const opts = getOptions()
    const ignorePaths = staticIgnorePaths ?? new Set(opts.ignorePaths ?? [])
    const prefix = opts.spanNamePrefix ?? 'HTTP'
    const path = c.req.path

    if (ignorePaths.has(path)) {
      return next()
    }

    const startTime = performance.now()

    // Extract inbound W3C trace context from request headers
    const inboundHeaders: Record<string, string> = {}
    const tp = c.req.header('traceparent')
    if (tp) inboundHeaders['traceparent'] = tp
    const ts = c.req.header('tracestate')
    if (ts) inboundHeaders['tracestate'] = ts
    const parentCtx = propagation.extract(context.active(), inboundHeaders)

    const tracer = trace.getTracer('@catalyst/telemetry')

    return context.with(parentCtx, async () => {
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
        let rawRoute: string | undefined
        try {
          rawRoute = getRoutePath(c, -1) ?? undefined
        } catch {
          /* no router state */
        }
        const routePattern = rawRoute && rawRoute !== '/*' ? rawRoute : path
        span.updateName(`${prefix} ${c.req.method} ${routePattern}`)
        span.setAttribute(ATTR_HTTP_ROUTE, routePattern)

        const status = c.res.status
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status)

        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR })
        }

        span.end()

        const durationSeconds = (performance.now() - startTime) / 1000
        const scheme = c.req.url.startsWith('https://') ? 'https' : 'http'
        const metricAttrs: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
          [ATTR_HTTP_ROUTE]: routePattern,
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
          [ATTR_URL_SCHEME]: scheme,
        }

        if (status >= 400) {
          metricAttrs[ATTR_ERROR_TYPE] = String(status)
        }

        getDurationHistogram().record(durationSeconds, metricAttrs)
      }
    })
  }
}
