import { describe, it, expect } from 'bun:test'
import { Role } from '../../src/policy/src/types.js'
import { jwtToEntity } from '../../src/jwt/index.js'

describe('jwtToEntity', () => {
  it('should map a JWT payload to a Cedar Entity with primary role and name', () => {
    const payload = {
      sub: 'user-123',
      entity: {
        id: 'user-123',
        name: 'alice',
        type: 'user',
        role: Role.ADMIN,
      },
      roles: [Role.ADMIN, Role.USER],
      claims: {
        orgId: 'org-456',
      },
    }

    const entity = jwtToEntity(payload as Record<string, unknown>)

    expect(entity.uid.type).toBe('ADMIN')
    expect(entity.uid.id).toBe('alice')
    expect(entity.attrs.id).toBe('user-123')
    expect(entity.attrs.name).toBe('alice')
    expect(entity.attrs.orgId).toBe('org-456')
  })

  it('should fallback to first role if primaryRole is missing', () => {
    const payload = {
      sub: 'node-01',
      entity: {
        id: 'node-01',
        name: 'catalyst-node-01',
        type: 'node',
      },
      roles: [Role.NODE],
    }

    const entity = jwtToEntity(payload as Record<string, unknown>)

    expect(entity.uid.type).toBe('NODE')
    expect(entity.uid.id).toBe('catalyst-node-01')
  })

  it('should fallback to sub if entity.name is missing', () => {
    const payload = {
      sub: 'user-789',
      roles: [Role.USER],
    }

    const entity = jwtToEntity(payload as Record<string, unknown>)

    expect(entity.uid.type).toBe('USER')
    expect(entity.uid.id).toBe('user-789')
  })
})
