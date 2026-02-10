import { describe, it, expect } from 'bun:test'
import { UserSchema } from '../src/models/user.js'

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
