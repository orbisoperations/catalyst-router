import { afterEach, describe, expect, it } from 'bun:test'
import { metrics, propagation, trace } from '@opentelemetry/api'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import { Hono } from 'hono'
import { telemetryMiddleware } from './hono'

function setupTracer() {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  provider.register()
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  return { exporter, provider }
}

function setupMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 50, // Short interval for tests
  })
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' }),
    readers: [reader],
  })
  metrics.setGlobalMeterProvider(provider)

  // Helper to collect metrics - waits for export cycle
  const collectMetrics = async () => {
    await reader.forceFlush()
    return exporter.getMetrics()
  }

  return { exporter, provider, reader, collectMetrics }
}

function createApp(options?: Parameters<typeof telemetryMiddleware>[0]) {
  const app = new Hono()
  app.use(telemetryMiddleware(options))
  app.get('/test', (c) => c.text('ok'))
  app.get('/health', (c) => c.text('ok'))
  app.get('/users/:id', (c) => c.text(`user ${c.req.param('id')}`))
  app.post('/items', (c) => c.text('created', 201))
  return app
}

describe('telemetryMiddleware', () => {
  afterEach(() => {
    trace.disable()
    propagation.disable()
  })

  describe('span creation', () => {
    it('creates a span for each request', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/test')

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)
      expect(spans[0].name).toBe('HTTP GET /test')
    })

    it('includes HTTP attributes on the span', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/test')

      const span = exporter.getFinishedSpans()[0]
      expect(span.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('GET')
      expect(span.attributes[ATTR_HTTP_ROUTE]).toBe('/test')
      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(200)
      expect(span.attributes[ATTR_URL_PATH]).toBe('/test')
    })

    it('records POST method and custom status codes', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/items', { method: 'POST' })

      const span = exporter.getFinishedSpans()[0]
      expect(span.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('POST')
      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(201)
    })

    it('normalizes path parameters in span name', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/users/550e8400-e29b-41d4-a716-446655440000')

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)
      // Should use the matched route pattern, not the raw path
      expect(spans[0].name).toBe('HTTP GET /users/:id')
    })

    it('uses normalizePath for unmatched routes (404)', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/users/550e8400-e29b-41d4-a716-446655440000/nonexistent')

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)
      // UUID should be normalized, not leaked as raw path
      expect(spans[0].name).toBe('HTTP GET /users/:uuid/nonexistent')
      expect(spans[0].attributes[ATTR_HTTP_ROUTE]).toBe('/users/:uuid/nonexistent')
    })
  })

  describe('spanNamePrefix', () => {
    it('uses custom prefix when provided', async () => {
      const { exporter } = setupTracer()
      const app = new Hono()
      app.use(telemetryMiddleware({ spanNamePrefix: 'RPC' }))
      app.get('/test', (c) => c.text('ok'))

      await app.request('/test')

      expect(exporter.getFinishedSpans()[0].name).toBe('RPC GET /test')
    })

    it('defaults to HTTP when no prefix provided', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      await app.request('/test')

      expect(exporter.getFinishedSpans()[0].name).toStartWith('HTTP ')
    })
  })

  describe('ignorePaths', () => {
    it('skips span creation for ignored paths', async () => {
      const { exporter } = setupTracer()
      const app = createApp({ ignorePaths: ['/health'] })

      await app.request('/health')

      expect(exporter.getFinishedSpans().length).toBe(0)
    })

    it('still creates spans for non-ignored paths', async () => {
      const { exporter } = setupTracer()
      const app = createApp({ ignorePaths: ['/health'] })

      await app.request('/test')

      expect(exporter.getFinishedSpans().length).toBe(1)
    })
  })

  describe('trace propagation', () => {
    it('continues parent trace from inbound traceparent header', async () => {
      const { exporter } = setupTracer()
      const app = createApp()

      // Create a parent span to generate a valid traceparent
      const tracer = trace.getTracer('test')
      const parentSpan = tracer.startSpan('parent')
      const parentCtx = parentSpan.spanContext()
      const traceparent = `00-${parentCtx.traceId}-${parentCtx.spanId}-01`
      parentSpan.end()

      await app.request('/test', {
        headers: { traceparent },
      })

      const spans = exporter.getFinishedSpans()
      const middlewareSpan = spans.find((s) => s.name === 'HTTP GET /test')
      expect(middlewareSpan).toBeDefined()
      // Should share the same traceId as the parent
      expect(middlewareSpan!.spanContext().traceId).toBe(parentCtx.traceId)
      // Should have parent span context set (OTEL SDK v2 uses parentSpanContext)
      expect(middlewareSpan!.parentSpanContext?.spanId).toBe(parentCtx.spanId)
    })
  })

  describe('error handling', () => {
    it('records error status on 5xx responses', async () => {
      const { exporter } = setupTracer()
      const app = new Hono()
      app.use(telemetryMiddleware())
      app.get('/error', () => {
        throw new Error('boom')
      })
      app.onError((err, c) => {
        return c.text(err.message, 500)
      })

      const res = await app.request('/error')
      expect(res.status).toBe(500)

      const span = exporter.getFinishedSpans()[0]
      expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(500)
      expect(span.status.code).toBe(2) // SpanStatusCode.ERROR
    })
  })

  describe('no-op behavior', () => {
    it('does not throw when no tracer provider is registered', async () => {
      // No setupTracer() — OTEL returns no-op tracer by default
      const app = createApp()

      const res = await app.request('/test')

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    })
  })

  describe('metrics', () => {
    afterEach(async () => {
      metrics.disable()
    })

    it('records http.server.request.duration histogram', async () => {
      setupTracer()
      const { exporter, reader } = setupMetrics()
      const app = createApp()

      await app.request('/test')
      await app.request('/test')

      await reader.forceFlush()

      const resourceMetrics = exporter.getMetrics()
      expect(resourceMetrics.length).toBeGreaterThan(0)

      const scopeMetrics = resourceMetrics[0].scopeMetrics
      const telemetryScope = scopeMetrics.find((sm) => sm.scope.name === '@catalyst/telemetry')
      expect(telemetryScope).toBeDefined()

      const histogramMetric = telemetryScope!.metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration'
      )
      expect(histogramMetric).toBeDefined()
      expect(histogramMetric!.descriptor.unit).toBe('s')

      const dataPoints = histogramMetric!.dataPoints
      expect(dataPoints.length).toBeGreaterThan(0)

      // Histogram data point should have count and sum
      const dp = dataPoints[0] as { value: { count: number; sum: number } }
      expect(dp.value.count).toBe(2) // Two requests
      expect(dp.value.sum).toBeGreaterThan(0)
      expect(dp.value.sum).toBeLessThan(1) // Should be well under 1 second
    })

    it('includes required OTEL semconv attributes', async () => {
      setupTracer()
      const { exporter, reader } = setupMetrics()
      const app = createApp()

      await app.request('/items', { method: 'POST' })

      await reader.forceFlush()

      const resourceMetrics = exporter.getMetrics()
      const scopeMetrics = resourceMetrics[0].scopeMetrics
      const telemetryScope = scopeMetrics.find((sm) => sm.scope.name === '@catalyst/telemetry')
      const histogramMetric = telemetryScope!.metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration'
      )

      const dp = histogramMetric!.dataPoints[0]
      expect(dp.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('POST')
      expect(dp.attributes[ATTR_HTTP_ROUTE]).toBe('/items')
      expect(dp.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(201)
      expect(dp.attributes[ATTR_URL_SCHEME]).toBe('http')
    })

    it('sets error.type attribute on 4xx/5xx responses', async () => {
      setupTracer()
      const { exporter, reader } = setupMetrics()
      const app = new Hono()
      app.use(telemetryMiddleware())
      app.get('/not-found', (c) => c.text('not found', 404))
      app.get('/error', (c) => c.text('server error', 500))

      await app.request('/not-found')
      await app.request('/error')

      await reader.forceFlush()

      const resourceMetrics = exporter.getMetrics()
      const scopeMetrics = resourceMetrics[0].scopeMetrics
      const telemetryScope = scopeMetrics.find((sm) => sm.scope.name === '@catalyst/telemetry')
      const histogramMetric = telemetryScope!.metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration'
      )

      const notFoundDp = histogramMetric!.dataPoints.find(
        (dp) => dp.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] === 404
      )
      expect(notFoundDp).toBeDefined()
      expect(notFoundDp!.attributes[ATTR_ERROR_TYPE]).toBe('404')

      const errorDp = histogramMetric!.dataPoints.find(
        (dp) => dp.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] === 500
      )
      expect(errorDp).toBeDefined()
      expect(errorDp!.attributes[ATTR_ERROR_TYPE]).toBe('500')
    })

    it('does not set error.type on successful responses', async () => {
      setupTracer()
      const { exporter, reader } = setupMetrics()
      const app = createApp()

      await app.request('/test')

      await reader.forceFlush()

      const resourceMetrics = exporter.getMetrics()
      const scopeMetrics = resourceMetrics[0].scopeMetrics
      const telemetryScope = scopeMetrics.find((sm) => sm.scope.name === '@catalyst/telemetry')
      const histogramMetric = telemetryScope!.metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration'
      )

      const dp = histogramMetric!.dataPoints[0]
      expect(dp.attributes[ATTR_ERROR_TYPE]).toBeUndefined()
    })

    it('skips metrics for ignored paths', async () => {
      setupTracer()
      const { exporter, reader } = setupMetrics()
      const app = createApp({ ignorePaths: ['/health'] })

      await app.request('/health')
      await app.request('/test')

      await reader.forceFlush()

      const resourceMetrics = exporter.getMetrics()
      const scopeMetrics = resourceMetrics[0].scopeMetrics
      const telemetryScope = scopeMetrics.find((sm) => sm.scope.name === '@catalyst/telemetry')
      const histogramMetric = telemetryScope!.metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration'
      )

      // Should only have /test, not /health
      const healthPoint = histogramMetric!.dataPoints.find(
        (dp) => dp.attributes[ATTR_HTTP_ROUTE] === '/health'
      )
      expect(healthPoint).toBeUndefined()

      const testPoint = histogramMetric!.dataPoints.find(
        (dp) => dp.attributes[ATTR_HTTP_ROUTE] === '/test'
      )
      expect(testPoint).toBeDefined()
    })
  })
})
