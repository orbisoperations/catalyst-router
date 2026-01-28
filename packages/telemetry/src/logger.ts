/**
 * @catalyst/telemetry — Logger configuration
 *
 * Configures LogTape with console and OTEL sinks.
 * All loggers use getLogger(name, ...subcategories) for consistent categories.
 */

import { configure, getLogger as logtapeGetLogger, reset } from '@logtape/logtape'
import type { Logger } from '@logtape/logtape'
import { createConsoleSink } from './sinks/console'
import { createOtelSink, shutdownLoggerProvider } from './sinks/otel'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'

interface LoggerOptions {
  loggerProvider?: LoggerProvider
  logLevel?: 'debug' | 'info' | 'warning' | 'error' | 'fatal'
  enableConsole?: boolean
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

  if (opts?.loggerProvider) {
    sinks['otel'] = createOtelSink({ loggerProvider: opts.loggerProvider })
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
