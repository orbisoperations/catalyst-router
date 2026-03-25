import { describe, expect, it } from 'vitest'
import { jwtToEntity } from '../../src/jwt/index.js'
import { Principal } from '../../src/policy/src/definitions/models.js'

describe('jwtToEntity', () => {
  it('should map a JWT payload to a Cedar Entity using principal directly', () => {
    const payload = {
      sub: 'user-123',
      principal: Principal.ADMIN,
      entity: {
        id: 'user-123',
        name: 'alice',
        type: 'user',
        nodeId: 'node-a',
      },
      claims: {
        orgId: 'org-456',
      },
    }

    const entity = jwtToEntity(payload as Record<string, unknown>)

    expect(entity.uid.type).toBe('CATALYST::ADMIN')
    expect(entity.uid.id).toBe('alice')
    expect(entity.attrs.id).toBe('user-123')
    expect(entity.attrs.name).toBe('alice')
    expect(entity.attrs.orgId).toBe('org-456')
  })

  it('should fallback to USER principal if principal is missing', () => {
    const payload = {
      sub: 'node-01',
      entity: {
        id: 'node-01',
        name: 'catalyst-node-01',
        type: 'node',
      },
    }

    const entity = jwtToEntity(payload)

    expect(entity.uid.type).toBe('CATALYST::USER')
    expect(entity.uid.id).toBe('catalyst-node-01')
  })

  it('should fallback to sub if entity.name is missing', () => {
    const payload = {
      sub: 'user-789',
      principal: Principal.USER,
    }

    const entity = jwtToEntity(payload)

    expect(entity.uid.type).toBe('CATALYST::USER')
    expect(entity.uid.id).toBe('user-789')
  })
})
