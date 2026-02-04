import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * @deprecated This permission system is deprecated in favor of Cedar policy engine.
 * Auth service has migrated to Cedar (see @catalyst/authorization/policy).
 * Orchestrator still depends on this - DO NOT REMOVE until orchestrator migration is complete.
 * See ADR-0008 for Cedar migration details.
 *
 * TODO: Remove this file after orchestrator migrates to Cedar
 */

/**
 * @deprecated Use Cedar Action enum from @catalyst/authorization instead
 * Explicit enumerated set of permissions.
 * Aligned with orchestrator requirements and new token management.
 */
export enum Permission {
  // Token management
  TokenCreate = 'token:create',
  TokenRevoke = 'token:revoke',
  TokenList = 'token:list',

  // Peer management
  PeerCreate = 'peer:create',
  PeerUpdate = 'peer:update',
  PeerDelete = 'peer:delete',

  // Route management
  RouteCreate = 'route:create',
  RouteDelete = 'route:delete',

  // Internal protocol (iBGP)
  IbgpConnect = 'ibgp:connect',
  IbgpDisconnect = 'ibgp:disconnect',
  IbgpUpdate = 'ibgp:update',

  // Administrative
  Admin = '*',
}

/**
 * @deprecated Use Cedar Role enum from @catalyst/authorization instead
 * Available roles in the system.
 */
export type Role = 'admin' | 'peer' | 'peer_custodian' | 'data_custodian' | 'user'

/**
 * @deprecated Use Cedar policies instead - see packages/authorization/src/policy/
 * Mapping between roles and their explicit permissions.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    Permission.TokenCreate,
    Permission.TokenRevoke,
    Permission.TokenList,
    Permission.PeerCreate,
    Permission.PeerUpdate,
    Permission.PeerDelete,
    Permission.RouteCreate,
    Permission.RouteDelete,
    Permission.IbgpConnect,
    Permission.IbgpDisconnect,
    Permission.IbgpUpdate,
    Permission.Admin,
  ],
  peer: [Permission.IbgpConnect, Permission.IbgpDisconnect, Permission.IbgpUpdate],
  peer_custodian: [
    Permission.PeerCreate,
    Permission.PeerUpdate,
    Permission.PeerDelete,
    Permission.IbgpConnect,
    Permission.IbgpDisconnect,
    Permission.IbgpUpdate,
  ],
  data_custodian: [Permission.RouteCreate, Permission.RouteDelete],
  user: [],
}

/**
 * @deprecated Use Cedar policy engine instead
 * Resolves a list of permissions for a given set of roles.
 */
export function getPermissionsForRoles(roles: string[]): Permission[] {
  const permissions = new Set<Permission>()
  for (const role of roles) {
    const rolePermissions = ROLE_PERMISSIONS[role as Role]
    if (rolePermissions) {
      rolePermissions.forEach((p) => permissions.add(p))
    } else {
      // If it's not a known role, it might be a direct permission string
      if (Object.values(Permission).includes(role as Permission)) {
        permissions.add(role as Permission)
      }
    }
  }
  return Array.from(permissions)
}

/**
 * @deprecated Use Cedar AuthorizationEngine.isAuthorized() instead
 * Checks if the given roles or permissions grant the required permission.
 *
 * Migration: Replace with Cedar policy checks
 * Example:
 *   const result = policyService.isAuthorized({
 *     principal, action, resource, entities, context
 *   })
 *   if (result.allowed) { ... }
 */
export function hasPermission(
  rolesOrPermissions: string[],
  required: Permission | string
): boolean {
  // All effective permissions for these roles
  const effectivePermissions = getPermissionsForRoles(rolesOrPermissions)

  // Admin always has permission
  if (effectivePermissions.includes(Permission.Admin)) {
    return true
  }

  // Check for direct match
  return effectivePermissions.includes(required as Permission)
}

/**
 * Timing-safe secret comparison.
 * Hashes both inputs to fixed-length digests before comparing,
 * eliminating any timing signal from input length differences.
 */
export function isSecretValid(provided: string, expected: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(provided), hash(expected))
}
