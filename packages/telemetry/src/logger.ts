/**
 * @catalyst/telemetry — Logger configuration
 *
 * Configures LogTape with console and OTEL sinks.
 * All loggers use getLogger(name, ...subcategories) for consistent categories.
 *
 * WHY create our own LoggerProvider: Unlike tracer/meter which use the global
 * OTEL API, LogTape bridges to OTEL via @logtape/otel which needs an explicit
 * LoggerProvider. We create one with BatchLogRecordProcessor + OTLPLogExporter
 * following the same pattern as tracer.ts and meter.ts.
 */

import { configure, getLogger as logtapeGetLogger, reset } from '@logtape/logtape'
import type { Logger } from '@logtape/logtape'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { createConsoleSink } from './sinks/console'
import { createOtelSink, setLoggerProvider, shutdownLoggerProvider } from './sinks/otel'
import { buildResource } from './resource'

interface LoggerOptions {
  /** Service name for OTEL resource attributes */
  serviceName?: string
  /** Service version for OTEL resource attributes */
  serviceVersion?: string
  /** Deployment environment for OTEL resource attributes */
  environment?: string
  /** OTLP endpoint for log export */
  otlpEndpoint?: string
  /** @internal Test-only: inject a pre-configured LoggerProvider */
  _testLoggerProvider?: LoggerProvider
  /** Minimum log level */
  logLevel?: 'debug' | 'info' | 'warning' | 'error' | 'fatal'
  /** Enable console sink (default: true) */
  enableConsole?: boolean
  /** Enable OTEL sink (default: true) */
  enableOtel?: boolean
}

let initialized = false

export async function initLogger(opts?: LoggerOptions): Promise<void> {
  if (initialized) {
    console.warn('[telemetry] Logger already initialized, ignoring duplicate initLogger call')
    return
  }

  const sinks: Record<string, ReturnType<typeof createOtelSink>> = {}
  const sinkNames: string[] = []

  if (opts?.enableConsole !== false) {
    sinks['console'] = createConsoleSink()
    sinkNames.push('console')
  }

  // Set up OTEL sink with either test provider or production exporter
  if (opts?.enableOtel !== false) {
    let loggerProvider: LoggerProvider

    if (opts?._testLoggerProvider) {
      // Test mode: use injected provider
      loggerProvider = opts._testLoggerProvider
    } else {
      /**
       * WHY we create our own LoggerProvider: The tracer and meter both create
       * OTLP exporters for production. The logger needs the same treatment to
       * ensure logs reach the collector alongside traces and metrics.
       *
       * WHY 5s timeout: Matches tracer.ts and meter.ts — bounds shutdown time
       * while still allowing reasonable export attempts.
       */
      const resource = buildResource({
        serviceName: opts?.serviceName ?? 'unknown_service',
        serviceVersion: opts?.serviceVersion,
        environment: opts?.environment,
      })

      const exporter = new OTLPLogExporter({
        url: `${opts?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/logs`,
        timeoutMillis: 5000,
      })

      loggerProvider = new LoggerProvider({
        resource,
        processors: [new BatchLogRecordProcessor(exporter)],
      })
    }

    // Track provider for shutdown (works for both test and production)
    setLoggerProvider(loggerProvider)
    sinks['otel'] = createOtelSink({ loggerProvider })
    sinkNames.push('otel')
  }

  await configure({
    sinks,
    loggers: [
      // Suppress LogTape meta logger from OTEL sink to avoid internal noise
      {
        category: ['logtape', 'meta'],
        sinks: opts?.enableConsole !== false ? ['console'] : [],
        lowestLevel: 'warning',
      },
      {
        category: [],
        sinks: sinkNames,
        lowestLevel: opts?.logLevel ?? 'info',
      },
    ],
  })

  initialized = true
}

export function getLogger(name: string, ...subcategories: string[]): Logger {
  return logtapeGetLogger([name, ...subcategories])
}

export async function shutdownLogger(): Promise<void> {
  if (!initialized) return
  initialized = false
  await reset()
  await shutdownLoggerProvider()
}
