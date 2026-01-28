/**
 * @catalyst/telemetry — OTEL log sink
 *
 * Bridges LogTape → OpenTelemetry Logs SDK via @logtape/otel.
 * Applies PII sanitization to log properties before export.
 */

import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { Sink } from '@logtape/logtape'
import { getOpenTelemetrySink } from '@logtape/otel'
import { sanitizeAttributes } from '../sanitizers'

interface OtelSinkOptions {
  loggerProvider?: LoggerProvider
}

let _loggerProvider: LoggerProvider | null = null

/**
 * Create a LogTape sink that forwards log records to OTEL via @logtape/otel,
 * with PII sanitization applied to log properties.
 */
export function createOtelSink(opts?: OtelSinkOptions): Sink {
  if (opts?.loggerProvider) {
    _loggerProvider = opts.loggerProvider
  }

  const otelSink = getOpenTelemetrySink({
    loggerProvider: opts?.loggerProvider,
  })

  return (record) => {
    // Sanitize structured properties before forwarding to OTEL
    if (record.properties && Object.keys(record.properties).length > 0) {
      const sanitized = sanitizeAttributes(record.properties as Record<string, unknown>)
      record = { ...record, properties: sanitized }
    }
    otelSink(record)
  }
}

export async function shutdownLoggerProvider(): Promise<void> {
  if (!_loggerProvider) return
  const p = _loggerProvider
  _loggerProvider = null
  await p.shutdown()
}
