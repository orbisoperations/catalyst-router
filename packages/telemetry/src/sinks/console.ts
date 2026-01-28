/**
 * @catalyst/telemetry — Console sink
 *
 * Wraps LogTape's getConsoleSink() with PII sanitization so that
 * sensitive data (passwords, tokens, emails) never reaches stdout,
 * even during local development.
 */

import { getConsoleSink } from '@logtape/logtape'
import type { Sink } from '@logtape/logtape'
import { sanitizeAttributes } from '../sanitizers'

export function createConsoleSink(): Sink {
  const inner = getConsoleSink()

  return (record) => {
    if (record.properties && Object.keys(record.properties).length > 0) {
      const sanitized = sanitizeAttributes(record.properties as Record<string, unknown>)
      record = { ...record, properties: sanitized }
    }
    inner(record)
  }
}
