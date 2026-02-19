import { configure, getLogger, reset } from '@logtape/logtape'
import type { LogLevel, LogRecord, Sink } from '@logtape/logtape'
import { trace, context } from '@opentelemetry/api'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc'
import type { ChannelCredentials } from '@grpc/grpc-js'
import { buildResource } from './resource.js'
import {
  DEFAULT_SERVICE_NAME,
  EXPORT_TIMEOUT_MS,
  validateLogLevel,
  validateEnvironment,
} from './constants.js'

export interface LoggerConfig {
  level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal'
  environment?: 'development' | 'production' | 'test'
  serviceName?: string
  serviceVersion?: string
  otlpEndpoint?: string
  serviceInstanceId?: string
  credentials?: ChannelCredentials
}

let configPromise: Promise<void> | null = null
let configured = false
let loggerProvider: LoggerProvider | null = null

const MAX_QUEUE_SIZE = 2048
const MAX_EXPORT_BATCH_SIZE = 512
const SCHEDULED_DELAY_MS = 5_000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    // Circular reference — retry with a replacer that marks cycles
    try {
      const seen = new WeakSet()
      return JSON.stringify(value, (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      })
    } catch {
      return String(value)
    }
  }
}

function formatMessage(record: LogRecord): string {
  return record.message.map((part) => (typeof part === 'string' ? part : String(part))).join('')
}

function flattenProperties(
  props: Record<string, unknown>
): Record<string, string | number | boolean> {
  const flat: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      flat[key] = value
    } else {
      flat[key] = safeStringify(value)
    }
  }
  return flat
}

function getTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active())
  if (!span) return {}
  const ctx = span.spanContext()
  return { traceId: ctx.traceId, spanId: ctx.spanId }
}

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

const LEVEL_COLORS: Record<string, string> = {
  debug: ANSI.dim,
  info: ANSI.cyan,
  warning: ANSI.yellow,
  error: ANSI.red,
  fatal: ANSI.magenta,
}

// ---------------------------------------------------------------------------
// Sink factories
// ---------------------------------------------------------------------------

function createPrettySink(): Sink {
  return (record: LogRecord) => {
    const time = new Date(record.timestamp).toISOString().slice(11, 23)
    const level = record.level.toUpperCase().padEnd(7)
    const color = LEVEL_COLORS[record.level] ?? ''
    const category = record.category.join('.')
    const msg = formatMessage(record)
    const props = Object.keys(record.properties).length
      ? ` ${safeStringify(record.properties)}`
      : ''
    console.log(
      `${ANSI.dim}${time}${ANSI.reset} ${color}${level}${ANSI.reset} ${ANSI.blue}${category}${ANSI.reset}: ${msg}${props}`
    )
  }
}

function createJsonSink(): Sink {
  return (record: LogRecord) => {
    const { traceId, spanId } = getTraceContext()
    const line = safeStringify({
      timestamp: record.timestamp,
      level: record.level,
      category: record.category.join('.'),
      message: formatMessage(record),
      ...(Object.keys(record.properties).length ? { properties: record.properties } : {}),
      ...(traceId ? { trace_id: traceId, span_id: spanId } : {}),
    })
    process.stdout.write(line + '\n')
  }
}

function createOtlpSink(
  endpoint: string,
  serviceName: string,
  serviceVersion?: string,
  environment?: string,
  serviceInstanceId?: string,
  credentials?: ChannelCredentials
): Sink {
  const resource = buildResource({ serviceName, serviceVersion, environment, serviceInstanceId })

  const exporter = new OTLPLogExporter({
    url: endpoint,
    timeoutMillis: EXPORT_TIMEOUT_MS,
    ...(credentials ? { credentials } : {}),
  })
  loggerProvider = new LoggerProvider({ resource })
  loggerProvider.addLogRecordProcessor(
    new BatchLogRecordProcessor(exporter, {
      maxQueueSize: MAX_QUEUE_SIZE,
      maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
      scheduledDelayMillis: SCHEDULED_DELAY_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    })
  )
  logs.setGlobalLoggerProvider(loggerProvider)

  const otelLogger = loggerProvider.getLogger(serviceName)

  return (record: LogRecord) => {
    const { traceId, spanId } = getTraceContext()
    otelLogger.emit({
      severityNumber: SEVERITY_MAP[record.level] ?? SeverityNumber.INFO,
      severityText: record.level.toUpperCase(),
      body: formatMessage(record),
      attributes: {
        ...flattenProperties(record.properties as Record<string, unknown>),
        'log.category': record.category.join('.'),
        ...(traceId ? { trace_id: traceId, span_id: spanId } : {}),
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure LogTape with environment-appropriate sinks.
 *
 * Selects sinks based on `NODE_ENV` and whether an OTLP endpoint is set
 * (see the log-sinks matrix in README). Safe to call multiple times —
 * subsequent calls are no-ops once configuration succeeds.
 */
export async function configureLogger(config?: LoggerConfig): Promise<void> {
  if (configured) return
  if (configPromise) return configPromise

  configPromise = doConfigureLogger(config)
    .then(() => {
      configured = true
    })
    .catch((err) => {
      configPromise = null
      throw err
    })
  return configPromise
}

async function doConfigureLogger(config?: LoggerConfig): Promise<void> {
  const level: LogLevel = config?.level ?? validateLogLevel(process.env.LOG_LEVEL) ?? 'info'
  const environment =
    config?.environment ?? validateEnvironment(process.env.NODE_ENV) ?? 'development'
  const serviceName = config?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME
  const serviceVersion = config?.serviceVersion ?? process.env.OTEL_SERVICE_VERSION
  const otlpEndpoint = config?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const serviceInstanceId = config?.serviceInstanceId

  const sinks: Record<string, Sink> = {}
  const sinkNames: string[] = []

  if (environment === 'production') {
    sinks.json = createJsonSink()
    sinkNames.push('json')
  } else {
    sinks.pretty = createPrettySink()
    sinkNames.push('pretty')
  }

  if (otlpEndpoint && environment !== 'test') {
    sinks.otlp = createOtlpSink(
      otlpEndpoint,
      serviceName,
      serviceVersion,
      environment,
      serviceInstanceId,
      config?.credentials
    )
    sinkNames.push('otlp')
  }

  await configure({
    sinks,
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: sinkNames },
      { category: ['catalyst'], lowestLevel: level, sinks: sinkNames },
    ],
  })
}

/**
 * Flush pending OTLP log records and shut down the logger provider.
 * No-op if no OTLP sink was configured.
 */
export async function shutdownLogger(): Promise<void> {
  if (loggerProvider) {
    await loggerProvider.shutdown()
    loggerProvider = null
  }
}

/**
 * @internal
 * Shut down the logger provider and reset all internal state so
 * `configureLogger` can be called again. Intended for test teardown only.
 */
export async function resetLogger(): Promise<void> {
  await shutdownLogger()
  await reset()
  configPromise = null
  configured = false
}

export { getLogger }
export type { LogLevel }
