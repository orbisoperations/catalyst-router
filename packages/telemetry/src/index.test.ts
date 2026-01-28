import { afterEach, describe, expect, it } from 'bun:test'
import { context, trace } from '@opentelemetry/api'
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node'
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { initTelemetry, shutdown } from './index'
import { getTracer } from './tracer'
import { getMeter } from './meter'
import { getLogger } from './logger'

function createTestExporters() {
  const spanExporter = new InMemorySpanExporter()
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const logExporter = new InMemoryLogRecordExporter()
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(logExporter)],
  })
  return { spanExporter, metricExporter, logExporter, loggerProvider }
}

describe('index (public API facade)', () => {
  afterEach(async () => {
    await shutdown()
  })

  describe('initTelemetry', () => {
    it('throws on empty serviceName', () => {
      expect(() =>
        initTelemetry({ serviceName: '', enableConsole: false } as any)
      ).toThrow('serviceName is required')
    })

    it('throws on whitespace-only serviceName', () => {
      expect(() =>
        initTelemetry({ serviceName: '   ', enableConsole: false } as any)
      ).toThrow('serviceName is required')
    })

    it('registers all providers with a single call', async () => {
      const { spanExporter, metricExporter, logExporter, loggerProvider } = createTestExporters()

      await initTelemetry({
        serviceName: 'integration-test',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })

      // Tracer works
      const tracer = getTracer('test')
      const span = tracer.startSpan('test-op')
      span.end()
      expect(spanExporter.getFinishedSpans().length).toBe(1)

      // Meter works
      const meter = getMeter('test')
      const counter = meter.createCounter('test.counter')
      counter.add(1)

      // Logger works
      const logger = getLogger('test')
      logger.info('hello')
      expect(logExporter.getFinishedLogRecords().length).toBe(1)
    })

    it('correlates trace context between spans and logs', async () => {
      const { spanExporter, metricExporter, logExporter, loggerProvider } = createTestExporters()

      await initTelemetry({
        serviceName: 'correlation-test',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('correlated-op')
      const ctx = trace.setSpan(context.active(), span)

      context.with(ctx, () => {
        const logger = getLogger('test')
        logger.info('log inside span')
      })
      span.end()

      const spans = spanExporter.getFinishedSpans()
      const logs = logExporter.getFinishedLogRecords()

      expect(spans.length).toBe(1)
      expect(logs.length).toBe(1)

      // Log should carry the same traceId as the span
      expect(logs[0].spanContext?.traceId).toBe(spans[0].spanContext().traceId)
    })

    it('warns and no-ops on double init', async () => {
      const first = createTestExporters()
      const second = createTestExporters()

      await initTelemetry({
        serviceName: 'first',
        _testSpanExporter: first.spanExporter,
        _testMetricExporter: first.metricExporter,
        _testLoggerProvider: first.loggerProvider,
        enableConsole: false,
      })
      await initTelemetry({
        serviceName: 'second',
        _testSpanExporter: second.spanExporter,
        _testMetricExporter: second.metricExporter,
        _testLoggerProvider: second.loggerProvider,
        enableConsole: false,
      })

      // Spans should go to first exporter only
      const tracer = getTracer('test')
      tracer.startSpan('test').end()
      expect(first.spanExporter.getFinishedSpans().length).toBe(1)
      expect(second.spanExporter.getFinishedSpans().length).toBe(0)
    })
  })

  describe('graceful degradation', () => {
    it('initializes without error when using test exporters', async () => {
      const { spanExporter, metricExporter, loggerProvider } = createTestExporters()

      await initTelemetry({
        serviceName: 'degradation-test',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })

      // Tracing works even with in-memory backend
      const tracer = getTracer('test')
      const span = tracer.startSpan('test')
      span.end()
      expect(spanExporter.getFinishedSpans().length).toBe(1)
    })

    it('span and log creation succeeds with test exporters', async () => {
      const { spanExporter, metricExporter, logExporter, loggerProvider } = createTestExporters()

      await initTelemetry({
        serviceName: 'no-collector',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })

      const tracer = getTracer('test')
      const span = tracer.startSpan('offline')
      span.end()

      const logger = getLogger('test')
      logger.info('offline log')
      logger.error('offline error')

      expect(spanExporter.getFinishedSpans().length).toBe(1)
      expect(logExporter.getFinishedLogRecords().length).toBe(2)
    })
  })

  describe('shutdown', () => {
    it('completes without error', async () => {
      const { spanExporter, metricExporter, loggerProvider } = createTestExporters()
      await initTelemetry({
        serviceName: 'shutdown-test',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })
      await shutdown()
    })

    it('is safe to call multiple times', async () => {
      const { spanExporter, metricExporter, loggerProvider } = createTestExporters()
      await initTelemetry({
        serviceName: 'shutdown-test',
        _testSpanExporter: spanExporter,
        _testMetricExporter: metricExporter,
        _testLoggerProvider: loggerProvider,
        enableConsole: false,
      })
      await shutdown()
      await shutdown()
    })
  })

  describe('re-exports', () => {
    it('exports all public API members', async () => {
      const mod = await import('./index')

      // Facade
      expect(typeof mod.initTelemetry).toBe('function')
      expect(typeof mod.shutdown).toBe('function')

      // Providers
      expect(typeof mod.getTracer).toBe('function')
      expect(typeof mod.getMeter).toBe('function')
      expect(typeof mod.getLogger).toBe('function')

      // Utilities
      expect(typeof mod.sanitizeAttributes).toBe('function')
      expect(typeof mod.normalizePath).toBe('function')

      // Propagation
      expect(typeof mod.injectTraceHeaders).toBe('function')
      expect(typeof mod.extractTraceContext).toBe('function')
      expect(typeof mod.getTraceId).toBe('function')
      expect(typeof mod.getSpanId).toBe('function')
    })
  })
})
