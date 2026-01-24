import { timingSafeEqual } from 'node:crypto'

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
export type Role = 'admin' | 'peer' | 'peer_custodian' | 'data_custodian' | 'user';

/**
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
    peer: [
        Permission.IbgpConnect,
        Permission.IbgpDisconnect,
        Permission.IbgpUpdate,
    ],
    peer_custodian: [
        Permission.PeerCreate,
        Permission.PeerUpdate,
        Permission.PeerDelete,
    ],
    data_custodian: [
        Permission.RouteCreate,
        Permission.RouteDelete,
    ],
    user: [],
};

/**
 * Resolves a list of permissions for a given set of roles.
 */
export function getPermissionsForRoles(roles: string[]): Permission[] {
    const permissions = new Set<Permission>();
    for (const role of roles) {
        const rolePermissions = ROLE_PERMISSIONS[role as Role];
        if (rolePermissions) {
            rolePermissions.forEach((p) => permissions.add(p));
        } else {
            // If it's not a known role, it might be a direct permission string
            if (Object.values(Permission).includes(role as Permission)) {
                permissions.add(role as Permission);
            }
        }
    }
    return Array.from(permissions);
}

/**
 * Checks if the given roles or permissions grant the required permission.
 */
export function hasPermission(rolesOrPermissions: string[], required: Permission | string): boolean {
    // All effective permissions for these roles
    const effectivePermissions = getPermissionsForRoles(rolesOrPermissions);

    // Admin always has permission
    if (effectivePermissions.includes(Permission.Admin)) {
        return true;
    }

    // Check for direct match
    return effectivePermissions.includes(required as Permission);
}

/**
 * Timing-safe secret comparison.
 */
export function isSecretValid(provided: string, expected: string): boolean {
    const providedBuf = Buffer.from(provided)
    const expectedBuf = Buffer.from(expected)

    if (providedBuf.length !== expectedBuf.length) {
        const maxLen = Math.max(providedBuf.length, expectedBuf.length)
        const paddedProvided = Buffer.alloc(maxLen)
        const paddedExpected = Buffer.alloc(maxLen)
        providedBuf.copy(paddedProvided)
        expectedBuf.copy(paddedExpected)

        timingSafeEqual(paddedProvided, paddedExpected)
        return false
    }

    return timingSafeEqual(providedBuf, expectedBuf)
}
