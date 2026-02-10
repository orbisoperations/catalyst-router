import { describe, it, expect, beforeEach } from 'bun:test'
import { InMemoryUserStore } from '../src/stores/memory.js'

describe('InMemoryUserStore', () => {
  let store: InMemoryUserStore

  beforeEach(() => {
    store = new InMemoryUserStore()
  })

  it('should create a user with generated id', async () => {
    const user = await store.create({
      email: 'test@example.com',
      passwordHash: 'hash123',
      roles: ['admin'],
      orgId: 'default',
    })

    expect(user.id).toMatch(/^usr_/)
    expect(user.email).toBe('test@example.com')
    expect(user.createdAt).toBeInstanceOf(Date)
  })

  it('should find user by id', async () => {
    const created = await store.create({
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'default',
    })

    const found = await store.findById(created.id)
    expect(found).not.toBeNull()
    expect(found?.email).toBe('test@example.com')
  })

  it('should find user by email and org (case-insensitive)', async () => {
    await store.create({
      email: 'Test@Example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'default',
    })

    const found = await store.findByEmail('test@example.com', 'default')
    expect(found).not.toBeNull()
    expect(found?.email).toBe('test@example.com')
  })

  it('should return null for non-existent user', async () => {
    const found = await store.findById('usr_nonexistent')
    expect(found).toBeNull()
  })

  it('should update user', async () => {
    const user = await store.create({
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'default',
    })

    const updated = await store.update(user.id, { lastLoginAt: new Date() })
    expect(updated.lastLoginAt).toBeInstanceOf(Date)
  })

  it('should delete user', async () => {
    const user = await store.create({
      email: 'test@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'default',
    })

    await store.delete(user.id)
    const found = await store.findById(user.id)
    expect(found).toBeNull()
  })

  it('should list users by org', async () => {
    await store.create({
      email: 'user1@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'org1',
    })
    await store.create({
      email: 'user2@example.com',
      passwordHash: 'hash',
      roles: ['admin'],
      orgId: 'org2',
    })

    const org1Users = await store.list('org1')
    expect(org1Users).toHaveLength(1)
    expect(org1Users[0].email).toBe('user1@example.com')
  })
})
