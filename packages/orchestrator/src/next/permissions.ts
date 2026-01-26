import { timingSafeEqual } from 'node:crypto'
import type { Action } from './schema.js'
import { Actions } from './action-types.js'

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
 * Unknown actions require explicit admin privileges.
 */
const ACTION_PERMISSION_MAP: Record<string, Permission> = {
  [Actions.LocalPeerCreate]: 'peer:create',
  [Actions.LocalPeerUpdate]: 'peer:update',
  [Actions.LocalPeerDelete]: 'peer:delete',
  [Actions.LocalRouteCreate]: 'route:create',
  [Actions.LocalRouteDelete]: 'route:delete',
  [Actions.InternalProtocolOpen]: 'ibgp:connect',
  [Actions.InternalProtocolClose]: 'ibgp:disconnect',
  [Actions.InternalProtocolConnected]: 'ibgp:connect',
  [Actions.InternalProtocolUpdate]: 'ibgp:update',
}

/**
 * Discrete roles and their associated permissions.
 */
export const ROLES: Record<string, Permission[]> = {
  admin: [
    'peer:create',
    'peer:update',
    'peer:delete',
    'route:create',
    'route:delete',
    'ibgp:connect',
    'ibgp:disconnect',
    'ibgp:update',
  ],
  networkcustodian: [
    'peer:create',
    'peer:update',
    'peer:delete',
    'ibgp:connect',
    'ibgp:disconnect',
    'ibgp:update',
  ],
  datacustodian: ['route:create', 'route:delete'],
  networkpeer: ['ibgp:connect', 'ibgp:disconnect', 'ibgp:update'],
}

/**
 * Returns the permission required to execute the given action.
 */
export function getRequiredPermission(action: Action): Permission | undefined {
  return ACTION_PERMISSION_MAP[action.action]
}

/**
 * Checks if the given roles include the required permission.
 *
 * Permission is granted if the user has a role that contains
 * the exact permission string.
 */
export function hasPermission(
  userRoles: string[],
  requiredPermission: Permission,
  userPermissions?: string[]
): boolean {
  // 1. Check direct permissions if provided
  if (userPermissions?.includes('*') || userPermissions?.includes(requiredPermission)) {
    return true
  }

  // 2. Check permissions inherited from roles
  for (const roleName of userRoles) {
    if (roleName === '*') return true // Support legacy wildcard role
    const permissions = ROLES[roleName] || []
    if (permissions.includes('*') || permissions.includes(requiredPermission)) {
      return true
    }
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
