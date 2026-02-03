import { describe, it, expect, beforeAll } from 'bun:test'
import { AuthRpcServer } from '../src/rpc/server.js'
import {
  LocalTokenManager,
  BunSqliteTokenStore,
  BunSqliteKeyStore,
  PersistentLocalKeyManager
} from '@catalyst/authorization'

describe('Auth Progressive API', () => {
  let keyManager: PersistentLocalKeyManager
  let tokenManager: LocalTokenManager
  let rpcServer: AuthRpcServer
  let adminToken: string
  let userToken: string

  beforeAll(async () => {
    const keyStore = new BunSqliteKeyStore(':memory:')
    keyManager = new PersistentLocalKeyManager(keyStore)
    await keyManager.initialize()

    const tokenStore = new BunSqliteTokenStore(':memory:')
    tokenManager = new LocalTokenManager(keyManager, tokenStore)

    // Sign tokens for testing
    adminToken = await tokenManager.mint({
      subject: 'admin-user',
      entity: { id: 'admin-user', name: 'Admin', type: 'user' },
      roles: ['ADMIN'],
    })

    userToken = await tokenManager.mint({
      subject: 'regular-user',
      entity: { id: 'regular-user', name: 'User', type: 'user' },
      roles: ['USER'],
    })

    rpcServer = new AuthRpcServer(keyManager, tokenManager)
  })

  describe('tokens sub-api', () => {
    it('should grant access to token handlers with valid admin token', async () => {
      const handlers = await rpcServer.tokens(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const tokenHandlers = handlers as any
      expect(tokenHandlers.create).toBeDefined()
      expect(tokenHandlers.revoke).toBeDefined()
      expect(tokenHandlers.list).toBeDefined()
    })

    it('should deny access to token handlers with non-admin token', async () => {
      const result = await rpcServer.tokens(userToken)
      expect(result).toHaveProperty('error')
      expect((result as any).error).toContain('ADMIN role required')
    })

    it('should allow creating and revoking a token via token handlers', async () => {
      const handlers = (await rpcServer.tokens(adminToken)) as any
      const newToken = await handlers.create({
        subject: 'new-service',
        entity: { id: 's1', name: 'Service', type: 'service' },
        roles: ['NODE']
      })
      expect(newToken).toBeString()

      // List and find it
      const tokens = await handlers.list({})
      expect(tokens.some((t: any) => t.entityId === 's1')).toBe(true)

      // Revoke it
      const jti = tokens.find((t: any) => t.entityId === 's1').jti
      await handlers.revoke({ jti })

      // Verify it is revoked
      const validation = (await rpcServer.validation(adminToken)) as any
      const verifyResult = await validation.validate({ token: newToken })
      expect(verifyResult.valid).toBe(false)
      expect(verifyResult.error).toContain('revoked')
    })
  })

  describe('certs sub-api', () => {
    it('should grant access to cert handlers with valid admin token', async () => {
      const handlers = await rpcServer.certs(adminToken)
      expect(handlers).not.toHaveProperty('error')
      const certHandlers = handlers as any
      expect(certHandlers.list).toBeDefined()
      expect(certHandlers.rotate).toBeDefined()
    })

    it('should allow rotating keys via cert handlers', async () => {
      const handlers = (await rpcServer.certs(adminToken)) as any
      const result = await handlers.rotate({ immediate: false })
      expect(result.success).toBe(true)
      expect(result.newKeyId).toBeString()
    })
  })

  describe('validation sub-api', () => {
    it('should grant access to validation handlers with any valid token', async () => {
      const result = await rpcServer.validation(userToken)
      expect(result).not.toHaveProperty('error')
      const handlers = result as any
      expect(handlers.validate).toBeDefined()
      expect(handlers.getJWKS).toBeDefined()
      expect(handlers.getRevocationList).toBeDefined()
    })

    it('should allow validating a token via validation handlers', async () => {
      const handlers = (await rpcServer.validation(adminToken)) as any
      const validationResult = await handlers.validate({ token: userToken })
      expect(validationResult.valid).toBe(true)
      expect(validationResult.payload.sub).toBe('regular-user')
    })

    it('should return revocation list', async () => {
      const handlers = (await rpcServer.validation(adminToken)) as any
      const crl = await handlers.getRevocationList()
      expect(Array.isArray(crl)).toBe(true)
    })
  })
})
