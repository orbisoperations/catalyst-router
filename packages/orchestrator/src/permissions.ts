import type { Action } from './schema.js'
import { Actions } from './action-types.js'

import { Permission } from '@catalyst/auth'
export { Permission } from '@catalyst/auth'
export type { Role } from '@catalyst/auth'

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

import { hasPermission as authHasPermission, isSecretValid as authIsSecretValid } from '@catalyst/auth'

/**
 * Checks if the given roles include the required permission.
 */
export function hasPermission(roles: string[], required: Permission): boolean {
  return authHasPermission(roles, required)
}

/**
 * Timing-safe secret comparison.
 */
export function isSecretValid(provided: string, expected: string): boolean {
  return authIsSecretValid(provided, expected)
}
