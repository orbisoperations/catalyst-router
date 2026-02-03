import { afterEach, describe, expect, it } from 'bun:test'
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { configure, getLogger, reset } from '@logtape/logtape'
import { createOtelSink, shutdownLoggerProvider } from './otel'

function createTestLoggerProvider() {
  const exporter = new InMemoryLogRecordExporter()
  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'test' }),
    processors: [new SimpleLogRecordProcessor(exporter)],
  })
  return { exporter, loggerProvider }
}

async function setupLogtape(sinkFn: ReturnType<typeof createOtelSink>) {
  await configure({
    sinks: { otel: sinkFn },
    loggers: [{ category: ['test'], sinks: ['otel'], lowestLevel: 'debug' }],
  })
}

describe('otel sink', () => {
  afterEach(async () => {
    await reset()
    await shutdownLoggerProvider()
  })

  describe('log record emission', () => {
    it('emits a log record through the sink', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      const logger = getLogger(['test'])
      logger.info('hello world')

      const records = exporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
      expect(records[0].body).toBe('hello world')
    })
  })

  describe('severity mapping', () => {
    it('maps debug to severityNumber 5', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).debug('debug msg')

      const records = exporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
      expect(records[0].severityNumber).toBe(5)
    })

    it('maps info to severityNumber 9', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).info('info msg')

      const records = exporter.getFinishedLogRecords()
      expect(records[0].severityNumber).toBe(9)
    })

    it('maps warning to severityNumber 13', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).warn('warn msg')

      const records = exporter.getFinishedLogRecords()
      expect(records[0].severityNumber).toBe(13)
    })

    it('maps error to severityNumber 17', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).error('error msg')

      const records = exporter.getFinishedLogRecords()
      expect(records[0].severityNumber).toBe(17)
    })
  })

  describe('PII sanitization', () => {
    it('redacts sensitive keys in log properties', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).info('login attempt', { password: 'secret123', username: 'alice' })

      const records = exporter.getFinishedLogRecords()
      expect(records.length).toBe(1)
      expect(records[0].attributes['password']).toBe('[REDACTED]')
      expect(records[0].attributes['username']).toBe('alice')
    })

    it('scrubs email addresses in log properties', async () => {
      const { exporter, loggerProvider } = createTestLoggerProvider()
      const sink = createOtelSink({ loggerProvider })
      await setupLogtape(sink)

      getLogger(['test']).info('user action', { email: 'alice@example.com' })

      const records = exporter.getFinishedLogRecords()
      expect(records[0].attributes['email']).toBe('[EMAIL]')
    })
  })
})
