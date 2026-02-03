import { afterEach, describe, expect, it } from 'bun:test'
import { context, trace } from '@opentelemetry/api'
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { initLogger, getLogger, shutdownLogger } from './logger'

function createTestProviders() {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' })

  const logExporter = new InMemoryLogRecordExporter()
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor(logExporter)],
  })

  const spanExporter = new InMemorySpanExporter()
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
  tracerProvider.register()

  return { logExporter, loggerProvider, spanExporter, tracerProvider }
}

describe('logger', () => {
  afterEach(async () => {
    await shutdownLogger()
    trace.disable()
  })

  describe('initLogger', () => {
    it('configures LogTape with OTEL sink', async () => {
      const { logExporter, loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const logger = getLogger('test-module')
      logger.info('hello from logger')

      const records = logExporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
      expect(records[0].body).toBe('hello from logger')
    })
  })

  describe('getLogger', () => {
    it('returns a logger for a single category', async () => {
      const { loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const logger = getLogger('gateway')
      expect(logger).toBeDefined()
      expect(typeof logger.info).toBe('function')
    })

    it('returns a logger for nested categories', async () => {
      const { logExporter, loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const logger = getLogger('gateway', 'federation')
      logger.info('nested log')

      const records = logExporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
      // Category should include both segments
      expect(records[0].attributes['category']).toEqual(['gateway', 'federation'])
    })
  })

  describe('trace context injection', () => {
    it('includes traceId and spanId when logging within an active span', async () => {
      const { logExporter, loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('test-op')
      const ctx = trace.setSpan(context.active(), span)

      context.with(ctx, () => {
        const logger = getLogger('test')
        logger.info('inside span')
      })
      span.end()

      const records = logExporter.getFinishedLogRecords()
      expect(records.length).toBe(1)

      const spanCtx = span.spanContext()
      expect(records[0].spanContext?.traceId).toBe(spanCtx.traceId)
      expect(records[0].spanContext?.spanId).toBe(spanCtx.spanId)
    })
  })

  describe('edge cases', () => {
    it('handles undefined properties without throwing', async () => {
      const { loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const logger = getLogger('test')
      logger.info('value is {value}', { value: undefined })
    })

    it('handles empty string messages', async () => {
      const { logExporter, loggerProvider } = createTestProviders()
      await initLogger({ _testLoggerProvider: loggerProvider, enableConsole: false })

      const logger = getLogger('test')
      logger.info('')

      const records = logExporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
    })
  })
})
