import { describe, it, expect } from 'bun:test'
import { UserSchema } from '../src/models/user.js'
import { ServiceAccountSchema } from '../src/models/service-account.js'

describe('UserSchema', () => {
  it('should validate a complete user', () => {
    const user = {
      id: 'usr_abc123',
      email: 'Admin@Example.Com',
      passwordHash: '$argon2id$...',
      roles: ['admin'],
      orgId: 'default',
      createdAt: new Date(),
    }

    const result = UserSchema.parse(user)
    expect(result.id).toBe('usr_abc123')
    expect(result.email).toBe('admin@example.com') // lowercased
    expect(result.roles).toEqual(['admin'])
  })

  it('should reject user without usr_ prefix', () => {
    const user = {
      id: 'invalid_id',
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      createdAt: new Date(),
    }

    expect(() => UserSchema.parse(user)).toThrow()
  })

  it('should reject user with empty roles', () => {
    const user = {
      id: 'usr_abc123',
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: [],
      createdAt: new Date(),
    }

    expect(() => UserSchema.parse(user)).toThrow()
  })

  it('should reject invalid email', () => {
    const user = {
      id: 'usr_abc123',
      email: 'not-an-email',
      passwordHash: 'hash',
      roles: ['admin'],
      createdAt: new Date(),
    }

    expect(() => UserSchema.parse(user)).toThrow()
  })

  it('should default orgId to "default"', () => {
    const user = {
      id: 'usr_abc123',
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      createdAt: new Date(),
    }

    const result = UserSchema.parse(user)
    expect(result.orgId).toBe('default')
  })
})

describe('ServiceAccountSchema', () => {
  it('should validate a complete service account', () => {
    const sa = {
      id: 'sa_xyz789',
      name: 'ci-pipeline',
      apiKeyHash: '$argon2id$...',
      keyPrefix: 'cat_sk_dflt_',
      roles: ['operator'],
      orgId: 'default',
      expiresAt: new Date(Date.now() + 86400000), // 1 day from now
      createdAt: new Date(),
      createdBy: 'usr_admin123',
    }

    const result = ServiceAccountSchema.parse(sa)
    expect(result.id).toBe('sa_xyz789')
    expect(result.name).toBe('ci-pipeline')
  })

  it('should reject service account without sa_ prefix', () => {
    const sa = {
      id: 'invalid_id',
      name: 'test',
      apiKeyHash: 'hash',
      keyPrefix: 'cat_sk_dflt_',
      roles: [],
      expiresAt: new Date(),
      createdAt: new Date(),
      createdBy: 'usr_admin',
    }

    expect(() => ServiceAccountSchema.parse(sa)).toThrow()
  })

  it('should reject invalid key prefix format', () => {
    const sa = {
      id: 'sa_xyz789',
      name: 'test',
      apiKeyHash: 'hash',
      keyPrefix: 'invalid_prefix',
      roles: [],
      expiresAt: new Date(),
      createdAt: new Date(),
      createdBy: 'usr_admin',
    }

    expect(() => ServiceAccountSchema.parse(sa)).toThrow()
  })

  it('should reject name over 100 characters', () => {
    const sa = {
      id: 'sa_xyz789',
      name: 'a'.repeat(101),
      apiKeyHash: 'hash',
      keyPrefix: 'cat_sk_dflt_',
      roles: [],
      expiresAt: new Date(),
      createdAt: new Date(),
      createdBy: 'usr_admin',
    }

    expect(() => ServiceAccountSchema.parse(sa)).toThrow()
  })

  it('should require expiresAt (max 1 year enforced elsewhere)', () => {
    const sa = {
      id: 'sa_xyz789',
      name: 'test',
      apiKeyHash: 'hash',
      keyPrefix: 'cat_sk_dflt_',
      roles: [],
      createdAt: new Date(),
      createdBy: 'usr_admin',
      // missing expiresAt
    }

    expect(() => ServiceAccountSchema.parse(sa)).toThrow()
  })
})
