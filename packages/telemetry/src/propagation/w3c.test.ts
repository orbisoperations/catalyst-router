import { afterEach, describe, expect, it } from 'bun:test'
import { context, propagation, trace } from '@opentelemetry/api'
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-node'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { injectTraceHeaders, extractTraceContext, getTraceId, getSpanId } from './w3c'

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

describe('w3c propagation', () => {
  afterEach(() => {
    trace.disable()
    propagation.disable()
  })

  describe('injectTraceHeaders', () => {
    it('adds traceparent to a headers object', () => {
      setupTracer()
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('inject-test')
      const ctx = trace.setSpan(context.active(), span)

      const headers: Record<string, string> = {}
      injectTraceHeaders(ctx, headers)
      span.end()

      expect(headers['traceparent']).toBeDefined()
      expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
    })

    it('uses active context when none provided', () => {
      setupTracer()
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('inject-test')
      const ctx = trace.setSpan(context.active(), span)

      const headers: Record<string, string> = {}
      context.with(ctx, () => {
        injectTraceHeaders(undefined, headers)
      })
      span.end()

      expect(headers['traceparent']).toBeDefined()
    })
  })

  describe('extractTraceContext', () => {
    it('extracts context from inbound traceparent header', () => {
      setupTracer()
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('source')
      const spanCtx = span.spanContext()

      // Build a valid traceparent
      const traceparent = `00-${spanCtx.traceId}-${spanCtx.spanId}-01`
      span.end()

      const extractedCtx = extractTraceContext({ traceparent })
      const extractedSpan = trace.getSpan(extractedCtx)

      expect(extractedSpan).toBeDefined()
      expect(extractedSpan!.spanContext().traceId).toBe(spanCtx.traceId)
    })
  })

  describe('getTraceId', () => {
    it('returns the active span traceId', () => {
      setupTracer()
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('trace-id-test')
      const ctx = trace.setSpan(context.active(), span)

      let traceId: string | undefined
      context.with(ctx, () => {
        traceId = getTraceId()
      })
      span.end()

      expect(traceId).toBe(span.spanContext().traceId)
      expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    })

    it('returns undefined when no active span', () => {
      expect(getTraceId()).toBeUndefined()
    })
  })

  describe('getSpanId', () => {
    it('returns the active span spanId', () => {
      setupTracer()
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('span-id-test')
      const ctx = trace.setSpan(context.active(), span)

      let spanId: string | undefined
      context.with(ctx, () => {
        spanId = getSpanId()
      })
      span.end()

      expect(spanId).toBe(span.spanContext().spanId)
      expect(spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it('returns undefined when no active span', () => {
      expect(getSpanId()).toBeUndefined()
    })
  })
})
