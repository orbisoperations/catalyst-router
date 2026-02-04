import { describe, it, expect, beforeEach } from 'bun:test'
import { LoginService } from '../src/login.js'
import { InMemoryUserStore } from '../src/stores/memory.js'
import { hashPassword } from '../src/password.js'
import {
  LocalTokenManager,
  BunSqliteTokenStore,
  BunSqliteKeyStore,
  PersistentLocalKeyManager,
} from '@catalyst/authorization'
import type { IKeyManager } from '../src/key-manager/types.js'

describe('LoginService', () => {
  let userStore: InMemoryUserStore
  let keyManager: IKeyManager
  let tokenManager: LocalTokenManager
  let service: LoginService

  beforeEach(async () => {
    userStore = new InMemoryUserStore()
    const keyStore = new BunSqliteKeyStore(':memory:')
    const pm = new PersistentLocalKeyManager(keyStore)
    await pm.initialize()
    keyManager = pm

    const tokenStore = new BunSqliteTokenStore(':memory:')
    tokenManager = new LocalTokenManager(keyManager, tokenStore)
    service = new LoginService(userStore, tokenManager)
  })

  describe('login', () => {
    it('should return JWT for valid credentials', async () => {
      // Create user with known password
      const passwordHash = await hashPassword('SecurePassword123!')
      await userStore.create({
        email: 'user@example.com',
        passwordHash,
        roles: ['admin'],
        orgId: 'default',
      })

      const result = await service.login({
        email: 'user@example.com',
        password: 'SecurePassword123!',
      })

      expect(result.success).toBe(true)
      expect(result.token).toBeDefined()
      expect(result.token?.length).toBeGreaterThan(50)
      expect(result.expiresAt).toBeInstanceOf(Date)
      expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now())
    })

    it('should reject wrong password', async () => {
      const passwordHash = await hashPassword('correctPassword')
      await userStore.create({
        email: 'user@example.com',
        passwordHash,
        roles: ['admin'],
        orgId: 'default',
      })

      const result = await service.login({
        email: 'user@example.com',
        password: 'wrongPassword',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid credentials')
      expect(result.token).toBeUndefined()
    })

    it('should reject unknown email (timing-safe)', async () => {
      // No user created - email doesn't exist
      const result = await service.login({
        email: 'unknown@example.com',
        password: 'anyPassword',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid credentials')
    })

    it('should normalize email to lowercase', async () => {
      const passwordHash = await hashPassword('myPassword123')
      await userStore.create({
        email: 'user@example.com',
        passwordHash,
        roles: ['admin'],
        orgId: 'default',
      })

      // Login with uppercase email
      const result = await service.login({
        email: 'USER@EXAMPLE.COM',
        password: 'myPassword123',
      })

      expect(result.success).toBe(true)
    })

    it('should include correct claims in JWT', async () => {
      const passwordHash = await hashPassword('testPassword')
      await userStore.create({
        email: 'admin@example.com',
        passwordHash,
        roles: ['ADMIN', 'OPERATOR'],
        orgId: 'default',
      })

      const result = await service.login({
        email: 'admin@example.com',
        password: 'testPassword',
      })

      expect(result.success).toBe(true)

      // Verify token by decoding
      const verifyResult = await tokenManager.verify(result.token!)
      if (!verifyResult.valid) {
        throw new Error(`Token verification failed: ${verifyResult.error}`)
      }
      expect(verifyResult.valid).toBe(true)
      expect(verifyResult.payload.sub).toMatch(/^usr_/)
      expect(verifyResult.payload.roles).toEqual(['ADMIN', 'OPERATOR'])
      expect(verifyResult.payload.orgId).toBe('default')
    })

    it('should update lastLoginAt on successful login', async () => {
      const passwordHash = await hashPassword('testPassword')
      const user = await userStore.create({
        email: 'user@example.com',
        passwordHash,
        roles: ['ADMIN'],
        orgId: 'default',
      })

      expect(user.lastLoginAt).toBeUndefined()

      await service.login({
        email: 'user@example.com',
        password: 'testPassword',
      })

      const updatedUser = await userStore.findById(user.id)
      expect(updatedUser?.lastLoginAt).toBeInstanceOf(Date)
    })
  })
})
