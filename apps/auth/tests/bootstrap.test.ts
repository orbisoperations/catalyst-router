import { describe, it, expect, beforeEach } from 'bun:test'
import { BootstrapService } from '../src/bootstrap.js'
import { InMemoryUserStore, InMemoryBootstrapStore } from '../src/stores/memory.js'

describe('BootstrapService', () => {
  let userStore: InMemoryUserStore
  let bootstrapStore: InMemoryBootstrapStore
  let service: BootstrapService

  beforeEach(async () => {
    userStore = new InMemoryUserStore()
    bootstrapStore = new InMemoryBootstrapStore()
    service = new BootstrapService(userStore, bootstrapStore)
  })

  describe('initializeBootstrap', () => {
    it('should create bootstrap state with hashed token', async () => {
      const result = await service.initializeBootstrap()

      expect(result.token).toBeDefined()
      expect(result.token.length).toBeGreaterThan(32)
      expect(result.expiresAt).toBeInstanceOf(Date)
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())

      const state = await bootstrapStore.get()
      expect(state).not.toBeNull()
      expect(state?.tokenHash).toMatch(/^\$argon2id\$/)
      expect(state?.used).toBe(false)
    })

    it('should fail if bootstrap already initialized', async () => {
      await service.initializeBootstrap()

      await expect(service.initializeBootstrap()).rejects.toThrow('Bootstrap already initialized')
    })
  })

  describe('createFirstAdmin', () => {
    it('should create admin user with valid bootstrap token', async () => {
      const { token } = await service.initializeBootstrap()

      const result = await service.createFirstAdmin({
        token,
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      expect(result.success).toBe(true)
      expect(result.userId).toMatch(/^usr_/)

      // Verify user was created
      const user = await userStore.findByEmail('admin@example.com')
      expect(user).not.toBeNull()
      expect(user?.roles).toContain('admin')

      // Verify bootstrap is marked as used
      const state = await bootstrapStore.get()
      expect(state?.used).toBe(true)
      expect(state?.createdAdminId).toBe(result.userId)
    })

    it('should reject invalid bootstrap token', async () => {
      await service.initializeBootstrap()

      const result = await service.createFirstAdmin({
        token: 'invalid-token',
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid or expired bootstrap token')
    })

    it('should reject if bootstrap already used', async () => {
      const { token } = await service.initializeBootstrap()

      // Use the token
      await service.createFirstAdmin({
        token,
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      // Try to use again (even with same valid token)
      const result = await service.createFirstAdmin({
        token,
        email: 'another@example.com',
        password: 'AnotherPassword123!',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Bootstrap already used')
    })

    it('should reject expired bootstrap token', async () => {
      // Initialize with very short expiry for testing
      const result = await service.initializeBootstrap({ expiresInMs: 1 })

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10))

      const createResult = await service.createFirstAdmin({
        token: result.token,
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      expect(createResult.success).toBe(false)
      expect(createResult.error).toBe('Invalid or expired bootstrap token')
    })

    it('should reject if no bootstrap initialized', async () => {
      const result = await service.createFirstAdmin({
        token: 'any-token',
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Bootstrap not initialized')
    })

    it('should normalize email to lowercase', async () => {
      const { token } = await service.initializeBootstrap()

      await service.createFirstAdmin({
        token,
        email: 'Admin@Example.COM',
        password: 'SecurePassword123!',
      })

      const user = await userStore.findByEmail('admin@example.com')
      expect(user).not.toBeNull()
      expect(user?.email).toBe('admin@example.com')
    })
  })

  describe('getBootstrapStatus', () => {
    it('should return not initialized when no bootstrap', async () => {
      const status = await service.getBootstrapStatus()

      expect(status.initialized).toBe(false)
      expect(status.used).toBe(false)
    })

    it('should return initialized but not used', async () => {
      await service.initializeBootstrap()

      const status = await service.getBootstrapStatus()

      expect(status.initialized).toBe(true)
      expect(status.used).toBe(false)
    })

    it('should return used after admin created', async () => {
      const { token } = await service.initializeBootstrap()
      await service.createFirstAdmin({
        token,
        email: 'admin@example.com',
        password: 'SecurePassword123!',
      })

      const status = await service.getBootstrapStatus()

      expect(status.initialized).toBe(true)
      expect(status.used).toBe(true)
    })
  })
})
