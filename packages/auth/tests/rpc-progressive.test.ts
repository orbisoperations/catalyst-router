import { describe, it, expect, beforeAll } from 'bun:test'
import { AuthRpcServer } from '../src/rpc/server.js'
import { EphemeralKeyManager } from '../src/key-manager/ephemeral.js'
import { InMemoryRevocationStore } from '../src/revocation.js'
import { LocalTokenManager, BunSqliteTokenStore } from '@catalyst/authorization'

describe('Auth Progressive API', () => {
  let keyManager: EphemeralKeyManager
  let tokenManager: LocalTokenManager
  let rpcServer: AuthRpcServer
  let adminToken: string
  let userToken: string

  beforeAll(async () => {
    keyManager = new EphemeralKeyManager()
    await keyManager.initialize()

    const tokenStore = new BunSqliteTokenStore(':memory:')
    tokenManager = new LocalTokenManager(keyManager, tokenStore)

    // Sign tokens for testing
    adminToken = await tokenManager.mint({
      subject: 'admin-user',
      entity: { id: 'admin-user', name: 'Admin', type: 'user' },
      claims: { roles: ['admin'] },
    })

    userToken = await tokenManager.mint({
      subject: 'regular-user',
      entity: { id: 'regular-user', name: 'User', type: 'user' },
      claims: { roles: ['user'] },
    })

    rpcServer = new AuthRpcServer(keyManager, tokenManager, new InMemoryRevocationStore())
  })

  describe('admin sub-api', () => {
    it('should grant access to admin handlers with valid admin token', async () => {
      const handlers = await rpcServer.admin(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const adminHandlers = handlers as any
      expect(adminHandlers.createToken).toBeDefined()
      expect(adminHandlers.revokeToken).toBeDefined()
    })

    it('should deny access to admin handlers with non-admin token', async () => {
      const result = await rpcServer.admin(userToken)
      expect(result).toHaveProperty('error')
      expect((result as any).error).toContain('admin role required')
    })

    it('should deny access with invalid token', async () => {
      const result = await rpcServer.admin('invalid-token')
      expect(result).toHaveProperty('error')
      expect((result as any).error).toBe('Invalid token')
    })

    it('should allow creating a token via admin handlers', async () => {
      const handlers = (await rpcServer.admin(adminToken)) as any
      const newToken = await handlers.createToken({ role: 'peer', name: 'new-peer' })
      expect(newToken).toBeString()
    })
  })

  describe('validation sub-api', () => {
    it('should grant access to validation handlers with any valid token', async () => {
      const result = await rpcServer.validation(userToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as any
      expect(handlers.validate).toBeDefined()
      expect(handlers.getJWKS).toBeDefined()
    })

    it('should deny access with invalid token', async () => {
      const result = await rpcServer.validation('invalid-token')
      expect(result).toHaveProperty('error')
      expect((result as any).error).toBe('Invalid token')
    })

    it('should allow validating a token via validation handlers', async () => {
      const handlers = (await rpcServer.validation(adminToken)) as any
      const validationResult = await handlers.validate({ token: userToken })
      expect(validationResult.valid).toBe(true)
      expect(validationResult.payload.sub).toBe('regular-user')
    })
  })
})
