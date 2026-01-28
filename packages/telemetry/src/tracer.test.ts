import { afterEach, describe, expect, it } from 'bun:test'
import { context, propagation, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node'
import { initTracer, getTracer, shutdownTracer } from './tracer'

describe('tracer', () => {
  afterEach(async () => {
    await shutdownTracer()
  })

  describe('initTracer', () => {
    it('registers a global TracerProvider', () => {
      initTracer({ serviceName: 'test-service' })

      const tracer = trace.getTracer('probe')
      expect(tracer).toBeDefined()
    })

    it('sets resource attributes: service.name, service.version, deployment.environment.name', () => {
      const exporter = new InMemorySpanExporter()
      initTracer({
        serviceName: 'my-service',
        serviceVersion: '1.2.3',
        environment: 'staging',
        _testExporter: exporter,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('test-span')
      span.end()

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)

      const resource = spans[0].resource
      expect(resource.attributes['service.name']).toBe('my-service')
      expect(resource.attributes['service.version']).toBe('1.2.3')
      expect(resource.attributes['deployment.environment.name']).toBe('staging')
    })

    it('uses default version and environment when not provided', () => {
      const exporter = new InMemorySpanExporter()
      initTracer({
        serviceName: 'default-test',
        _testExporter: exporter,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('test-span')
      span.end()

      const spans = exporter.getFinishedSpans()
      const resource = spans[0].resource
      expect(resource.attributes['service.version']).toBe('0.0.0')
      expect(resource.attributes['deployment.environment.name']).toBe('development')
    })

    it('sets W3CTraceContextPropagator globally', () => {
      const exporter = new InMemorySpanExporter()
      initTracer({ serviceName: 'test-service', _testExporter: exporter })

      // Create a span so there's an active trace context to propagate
      const tracer = getTracer('test')
      const span = tracer.startSpan('propagation-test')
      const ctx = trace.setSpan(context.active(), span)

      const carrier: Record<string, string> = {}
      propagation.inject(ctx, carrier)
      span.end()

      // W3C propagator should inject a traceparent header
      expect(carrier['traceparent']).toBeDefined()
      expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    })

    it('silently no-ops on duplicate init', () => {
      const exporter1 = new InMemorySpanExporter()
      const exporter2 = new InMemorySpanExporter()
      initTracer({ serviceName: 'first', _testExporter: exporter1 })
      initTracer({ serviceName: 'second', _testExporter: exporter2 })

      // Spans should go to the first exporter, not the second
      const tracer = getTracer('test')
      const span = tracer.startSpan('test-span')
      span.end()

      expect(exporter1.getFinishedSpans().length).toBe(1)
      expect(exporter2.getFinishedSpans().length).toBe(0)
    })
  })

  describe('getTracer', () => {
    it('returns a Tracer instance', () => {
      initTracer({ serviceName: 'test-service' })

      const tracer = getTracer('my-module')
      expect(tracer).toBeDefined()
      expect(typeof tracer.startSpan).toBe('function')
    })

    it('returns a no-op tracer before init', () => {
      const tracer = getTracer('before-init')
      expect(tracer).toBeDefined()
      // No-op tracer still has startSpan, but spans are no-ops
      const span = tracer.startSpan('no-op')
      span.end() // should not throw
    })
  })

  describe('span creation', () => {
    it('produces spans with valid traceId and spanId', () => {
      const exporter = new InMemorySpanExporter()
      initTracer({
        serviceName: 'test-service',
        _testExporter: exporter,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('my-operation')
      span.end()

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)

      const finished = spans[0]
      expect(finished.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(finished.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('shutdownTracer', () => {
    it('completes without error after spans are created', async () => {
      const exporter = new InMemorySpanExporter()
      initTracer({
        serviceName: 'test-service',
        _testExporter: exporter,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('before-shutdown')
      span.end()

      const spans = exporter.getFinishedSpans()
      expect(spans.length).toBe(1)

      await shutdownTracer()
    })

    it('is safe to call multiple times', async () => {
      initTracer({ serviceName: 'test-service' })
      await shutdownTracer()
      await shutdownTracer()
    })
  })
})
