import type { IsAllowedRequest, Principal, Resource, Value } from '@cerbos/core'
import { timingSafeEqual } from 'node:crypto'
import { GRPC as CerbosGRPC } from '@cerbos/grpc'

/**
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
 * Available roles in the system.
 */
export type Role = 'admin' | 'peer' | 'peer_custodian' | 'data_custodian' | 'user'

/**
 * Mapping between roles and their explicit permissions.
 */
// todo: remove this and replace with the new permission service via RPC on the orchestrator
// change for validateion().isAuthorized() RCP Call made available in rpc/server.ts
// the permission policy schema is now defined in /packages/auth/cerbos/policies
// validate with bun policy:test
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
  peer_custodian: [Permission.PeerCreate, Permission.PeerUpdate, Permission.PeerDelete],
  data_custodian: [Permission.RouteCreate, Permission.RouteDelete],
  user: [],
}

/**
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

// TODO: for @gabriel, remove this function and replace with
// the new permission service via RPC on the orchestrator
// change for validateion().isAuthorized() RCP Call made available in rpc/server.ts
/**
 * Checks if the given roles or permissions grant the required permission.
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
 */
export function isSecretValid(provided: string, expected: string): boolean {
  console.log('provided', provided, 'expected', expected)
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) {
    const bufLen = providedBuf.length
    const paddedExpected = Buffer.alloc(bufLen)
    expectedBuf.copy(paddedExpected)
    timingSafeEqual(providedBuf, paddedExpected)
    return false
  }
  return timingSafeEqual(providedBuf, expectedBuf)
}

// Principal Definition
export type PrincipalAttributes = 'orgId'
export type CatalystPrincipal = Principal & {
  roles: Role[]
  attr?: Partial<Record<PrincipalAttributes, Value>> | undefined
}

// Resource Definitions
export type PeerAttributes = 'peerId' | 'name' | 'endpoint' | 'domains'
export type RouteAttributes = 'protocol' | 'peerId' | 'nodePath' | 'region' | 'tags'
export type CatalystResource = Resource &
  (
    | {
        kind: 'peer'
        attr?: Partial<Record<PeerAttributes, Value>> | undefined
      }
    | {
        kind: 'route'
        attr?: Partial<Record<RouteAttributes, Value>> | undefined
      }
    | {
        kind: 'ibgp'
      }
    | {
        kind: 'token'
      }
  )

export class PermissionService {
  private cerbosClient: CerbosGRPC

  constructor(url: string) {
    this.cerbosClient = new CerbosGRPC(url, { tls: false })
  }

  async isAuthorized(
    principal: CatalystPrincipal,
    resource: CatalystResource,
    permission: Permission
  ): Promise<boolean> {
    const requestId = crypto.randomUUID()
    console.log(
      '[PermissionService] Authorization requested for',
      JSON.stringify({
        requestId,
        principal: { ...principal, id: undefined },
        resource,
        permission,
      })
    )
    const action = permission.split(':').pop() as Permission
    const request: IsAllowedRequest = {
      requestId: requestId,
      principal: principal,
      resource: resource,
      action: action,
    }
    return this.cerbosClient.isAllowed(request)
  }
}
