import { timingSafeEqual } from 'node:crypto'
import type { Action } from './schema.js'
import { Actions } from './action-types.js'

import { Permission } from '@catalyst/auth'

/**
 * Maps action types to their required permissions.
 * Unknown actions require explicit admin privileges.
 */
const ACTION_PERMISSION_MAP: Record<string, Permission> = {
  [Actions.LocalPeerCreate]: Permission.PeerCreate,
  [Actions.LocalPeerUpdate]: Permission.PeerUpdate,
  [Actions.LocalPeerDelete]: Permission.PeerDelete,
  [Actions.LocalRouteCreate]: Permission.RouteCreate,
  [Actions.LocalRouteDelete]: Permission.RouteDelete,
  [Actions.InternalProtocolOpen]: Permission.IbgpConnect,
  [Actions.InternalProtocolClose]: Permission.IbgpDisconnect,
  [Actions.InternalProtocolConnected]: Permission.IbgpConnect,
  [Actions.InternalProtocolUpdate]: Permission.IbgpUpdate,
}

/**
 * Discrete roles and their associated permissions.
 */
export function getRequiredPermission(action: Action): Permission {
  return ACTION_PERMISSION_MAP[action.action] ?? Permission.Admin
}

import { hasPermission as authHasPermission } from '@catalyst/auth'

/**
 * Checks if the given roles include the required permission.
 */
export function hasPermission(roles: string[], required: Permission): boolean {
  return authHasPermission(roles, required)
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
