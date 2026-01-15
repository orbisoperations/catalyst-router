/**
 * Role-based access control (RBAC) for actions.
 *
 * Permission format: 'resource:action' or '*' for all.
 */

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  // Full access
  admin: ['*'],

  // Can manage data channels
  operator: ['dataChannel:create', 'dataChannel:update', 'dataChannel:delete'],

  // Read-only access (no write actions allowed)
  viewer: [],
}

/**
 * Check if any of the given roles grants permission for the action.
 */
export function hasPermission(
  roles: string[] | undefined,
  resource: string,
  action: string
): boolean {
  if (!roles || roles.length === 0) {
    return false
  }

  const requiredPermission = `${resource}:${action}`

  return roles.some((role) => {
    const allowed = ROLE_PERMISSIONS[role]
    if (!allowed) {
      return false
    }
    return allowed.includes('*') || allowed.includes(requiredPermission)
  })
}
