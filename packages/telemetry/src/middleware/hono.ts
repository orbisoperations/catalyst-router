/**
 * @catalyst/telemetry — Hono telemetry middleware
 *
 * Auto-creates a span per HTTP request with method, route, status, and duration.
 * Records HTTP server metrics (request count and duration histogram).
 * Extracts inbound W3C traceparent for distributed trace propagation.
 *
 * Follows stable HTTP semantic conventions (v1.23.0+):
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-spans/
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 *
 * Span naming follows the {method} {route} convention:
 * @see https://opentelemetry.io/blog/2025/how-to-name-your-spans/
 */

import { type Context, type MiddlewareHandler } from 'hono'
import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import { normalizePath } from '../normalize'
import type { MiddlewareOptions } from '../types'

// Metric name per OTEL HTTP semconv
const METRIC_HTTP_SERVER_REQUEST_DURATION = 'http.server.request.duration'

// WHY these buckets: OTEL semconv recommended boundaries for HTTP latency
// @see https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

/**
 * WHY no module-level caching: Metrics instruments are tied to a specific
 * MeterProvider. Caching at module level breaks when providers change
 * (e.g., in tests). The overhead of getMeter/createHistogram per request
 * is negligible since OTEL SDK caches internally by instrument name.
 *
 * WHY no counter: OTEL semconv only defines http.server.request.duration histogram.
 * The histogram's internal count (_count in Prometheus) provides request count.
 */
function getMetrics() {
  const meter = metrics.getMeter('@catalyst/telemetry')
  const durationHistogram = meter.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, {
    description: 'Duration of HTTP server requests',
    unit: 's',
    advice: {
      explicitBucketBoundaries: DURATION_BUCKETS,
    },
  })
  return { durationHistogram }
}

/**
 * Hono middleware that instruments every HTTP request with OpenTelemetry.
 *
 * **Tracing:**
 * - Creates a span named `{prefix} {METHOD} {route}` (prefix defaults to "HTTP")
 * - Records stable semconv attributes: `http.request.method`, `http.route`,
 *   `http.response.status_code`, `url.path`
 * - Extracts inbound `traceparent` header for distributed trace propagation
 *
 * **Metrics:**
 * - `http.server.request.duration` — Histogram of request duration in seconds
 *   (histogram count provides request total via `_count` in Prometheus)
 *
 * Skips instrumentation for paths listed in `ignorePaths` (exact match).
 */
export function telemetryMiddleware(options?: MiddlewareOptions): MiddlewareHandler {
  const ignorePaths = new Set(options?.ignorePaths ?? [])
  const prefix = options?.spanNamePrefix ?? 'HTTP'

  return async (c: Context, next: () => Promise<void>) => {
    const path = c.req.path

    if (ignorePaths.has(path)) {
      return next()
    }

    const startTime = performance.now()

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

        // Record metrics with OTEL semconv required attributes
        const durationSeconds = (performance.now() - startTime) / 1000
        // WHY try/catch: Defensive against malformed URLs from proxies/edge cases.
        // Hono typically guarantees valid URLs, but observability code should not throw.
        let scheme = 'http'
        try {
          scheme = new URL(c.req.url).protocol.replace(':', '')
        } catch {
          // Malformed URL - default to http
        }
        const metricAttrs: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
          [ATTR_HTTP_ROUTE]: routePattern,
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
          [ATTR_URL_SCHEME]: scheme,
        }

        // Add error.type per OTEL semconv when request ends with error
        if (status >= 400) {
          metricAttrs[ATTR_ERROR_TYPE] = String(status)
        }

        const { durationHistogram } = getMetrics()
        durationHistogram.record(durationSeconds, metricAttrs)
      }
    })
  }
}
