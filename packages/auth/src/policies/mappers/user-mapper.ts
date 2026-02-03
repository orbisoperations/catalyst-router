import type { EntityUid, Mapper } from '@catalyst/authorization'
import type { CatalystPolicyDomain, UserEntity } from '../types'

/**
 * Maps a user object to an entity for the CatalystPolicyDomain.
 * @param user - The user object to convert to an entity.
 * @returns The entity representing the user.
 */
export const userModelToEntityMapper: Mapper<CatalystPolicyDomain, UserEntity> = (
  user: UserEntity
) => {
  const roles: EntityUid<CatalystPolicyDomain, 'Role'>[] = user.roles.map((role) => ({
    type: 'Role',
    id: role,
  }))

  return {
    id: user.id,
    attrs: {
      email: user.email,
      orgId: user.orgId,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    parents: roles,
  }
}
