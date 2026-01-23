import { timingSafeEqual } from 'node:crypto'
import type { Action } from './schema.js'

/**
 * Permission types for RBAC.
 * Actions map to these permissions via ACTION_PERMISSION_MAP.
 */
export type Permission =
  | 'peer:create'
  | 'peer:update'
  | 'peer:delete'
  | 'route:create'
  | 'route:delete'
  | 'ibgp:connect'
  | 'ibgp:disconnect'
  | 'ibgp:update'
  | '*'

/**
 * Maps action types to their required permissions.
 * Unknown actions require '*' (admin only).
 */
const ACTION_PERMISSION_MAP: Record<string, Permission> = {
  'local:peer:create': 'peer:create',
  'local:peer:update': 'peer:update',
  'local:peer:delete': 'peer:delete',
  'local:route:create': 'route:create',
  'local:route:delete': 'route:delete',
  'internal:protocol:open': 'ibgp:connect',
  'internal:protocol:close': 'ibgp:disconnect',
  'internal:protocol:connected': 'ibgp:connect',
  'internal:protocol:update': 'ibgp:update',
}

/**
 * Returns the permission required to execute the given action.
 * Unknown actions require '*' (admin only).
 */
export function getRequiredPermission(action: Action): Permission {
  return ACTION_PERMISSION_MAP[action.action] ?? '*'
}

/**
 * Checks if the given roles include the required permission.
 *
 * Permission is granted if roles include:
 * - '*' (superuser)
 * - 'admin' (admin role)
 * - The exact permission string
 * - A category wildcard (e.g., 'peer:*' grants 'peer:create')
 */
export function hasPermission(roles: string[], required: Permission): boolean {
  // Superuser or admin grants everything
  if (roles.includes('*') || roles.includes('admin')) {
    return true
  }

  // Direct permission match
  if (roles.includes(required)) {
    return true
  }

  // Category wildcard (e.g., 'peer:*' matches 'peer:create')
  const [category] = required.split(':')
  if (roles.includes(`${category}:*`)) {
    return true
  }

  return false
}

/**
 * Timing-safe secret comparison.
 * Prevents timing attacks by:
 * 1. Using crypto.timingSafeEqual for constant-time comparison
 * 2. Padding shorter strings to prevent length-based timing leaks
 *
 * @param provided - The secret provided by the caller
 * @param expected - The expected secret from config
 * @returns true if secrets match, false otherwise
 */
export function isSecretValid(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)

  // If lengths differ, pad the shorter one and still run comparison
  // This prevents timing attacks based on early-exit for length mismatch
  if (providedBuf.length !== expectedBuf.length) {
    // Pad to match the longer length
    const maxLen = Math.max(providedBuf.length, expectedBuf.length)
    const paddedProvided = Buffer.alloc(maxLen)
    const paddedExpected = Buffer.alloc(maxLen)
    providedBuf.copy(paddedProvided)
    expectedBuf.copy(paddedExpected)

    // Run comparison but always return false for length mismatch
    timingSafeEqual(paddedProvided, paddedExpected)
    return false
  }

  return timingSafeEqual(providedBuf, expectedBuf)
}
