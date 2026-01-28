/**
 * @catalyst/telemetry — PII sanitization utilities
 *
 * Redacts sensitive attribute keys and scrubs email addresses
 * from telemetry data before export.
 *
 * WHY recursive: OTEL span attributes are flat key-value pairs, but
 * log properties (via LogTape) and custom attributes can contain nested
 * objects and arrays. Flat-only sanitization creates a false sense of
 * safety — nested PII passes through undetected.
 */

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|authorization|cookie|api[_-]?key|bearer|credential|private[_-]?key/i

/**
 * WHY inline pattern (no ^ $ anchors): Log messages commonly embed emails
 * in strings like "User alice@example.com logged in". An anchored pattern
 * only matches values that ARE an email, missing inline occurrences.
 */
const EMAIL_INLINE_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/**
 * Sanitize span/log attributes by redacting sensitive keys and scrubbing emails.
 *
 * - Keys matching sensitive patterns (case-insensitive) → `[REDACTED]`
 * - String values containing email addresses → emails replaced with `[EMAIL]`
 * - Nested objects → recursively sanitized
 * - Arrays → elements sanitized individually
 * - All other values pass through unchanged.
 *
 * Returns a new object; the input is not mutated.
 */
export function sanitizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(attrs)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = sanitizeValue(value)
    }
  }

  return result
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL_INLINE_PATTERN, '[EMAIL]')
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeAttributes(value as Record<string, unknown>)
  }
  return value
}
