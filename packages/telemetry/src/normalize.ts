/**
 * @catalyst/telemetry — Path normalization utilities
 *
 * Replaces dynamic path segments (UUIDs, numeric IDs) with placeholders
 * to prevent high-cardinality metric labels.
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const NUMERIC_SEGMENT_PATTERN = /^\d+$/

/**
 * Normalize an HTTP path by replacing dynamic segments with placeholders.
 *
 * - UUIDs → `:uuid`
 * - Purely numeric segments → `:id`
 * - All other segments pass through unchanged.
 *
 * @example
 * normalizePath('/users/550e8400-e29b-41d4-a716-446655440000/orders')
 * // → '/users/:uuid/orders'
 *
 * normalizePath('/items/12345')
 * // → '/items/:id'
 */
export function normalizePath(path: string): string {
  if (!path) return path

  // Replace UUIDs first (they contain digits, so must come before numeric check)
  let normalized = path.replace(UUID_PATTERN, ':uuid')

  // Then replace remaining purely numeric segments
  const segments = normalized.split('/')
  normalized = segments
    .map((segment) => (NUMERIC_SEGMENT_PATTERN.test(segment) ? ':id' : segment))
    .join('/')

  return normalized
}
