import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as jose from 'jose'
import { JWTTokenFactory } from '../../src/jwt/jwt-token-factory.js'
import { Role } from '../../src/policy/src/definitions/models.js'

describe('JWTTokenFactory', () => {
  let factory: JWTTokenFactory

  beforeEach(async () => {
    factory = JWTTokenFactory.ephemeral({ nodeId: 'test-node' })
    await factory.initialize()
  })

  afterEach(async () => {
    await factory.shutdown()
  })

  const mintTestToken = (overrides?: Partial<Parameters<typeof factory.mint>[0]>) =>
    factory.mint({
      subject: 'user-1',
      roles: [Role.USER],
      entity: {
        id: 'user-1',
        name: 'alice',
        type: 'user',
        role: Role.USER,
      },
      ...overrides,
    })

  describe('lifecycle', () => {
    it('should report initialized state correctly', () => {
      expect(factory.isInitialized()).toBe(true)
    })

    it('should report uninitialized before initialize()', () => {
      const fresh = JWTTokenFactory.ephemeral()
      expect(fresh.isInitialized()).toBe(false)
    })

    it('should be safe to call initialize() multiple times', async () => {
      await factory.initialize()
      await factory.initialize()
      expect(factory.isInitialized()).toBe(true)
    })

    it('should be safe to call shutdown() without initialization', async () => {
      const fresh = JWTTokenFactory.ephemeral()
      await fresh.shutdown()
    })
  })

  describe('ephemeral()', () => {
    it('should create a working factory with in-memory stores', async () => {
      const token = await mintTestToken()
      expect(token).toBeString()

      const result = await factory.verify(token)
      expect(result.valid).toBe(true)
    })

    it('should forward nodeId option', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)
      const entity = decoded.entity as Record<string, unknown>
      expect(entity.nodeId).toBe('test-node')
    })

    it('should forward gracePeriodMs option', async () => {
      const customFactory = JWTTokenFactory.ephemeral({
        gracePeriodMs: 1000,
      })
      await customFactory.initialize()

      const token = await customFactory.mint({
        subject: 'user-1',
        roles: [Role.USER],
        entity: { id: 'u1', name: 'alice', type: 'user', role: Role.USER },
      })

      const result = await customFactory.rotate({ gracePeriodMs: 1000 })
      expect(result.gracePeriodEndsAt).toBeDefined()

      // Token signed with old key should still verify during grace period
      const verifyResult = await customFactory.verify(token)
      expect(verifyResult.valid).toBe(true)

      await customFactory.shutdown()
    })
  })

  describe('mint', () => {
    it('should mint a valid JWT', async () => {
      const token = await mintTestToken()
      expect(token).toBeString()
      expect(token.split('.')).toHaveLength(3)
    })

    it('should auto-inject nodeId into minted tokens', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)
      const entity = decoded.entity as Record<string, unknown>
      expect(entity.nodeId).toBe('test-node')
    })

    it('should not overwrite explicitly provided nodeId', async () => {
      const token = await mintTestToken({
        entity: {
          id: 'user-1',
          name: 'alice',
          type: 'user',
          role: Role.USER,
          nodeId: 'explicit-node',
        },
      })
      const decoded = jose.decodeJwt(token)
      const entity = decoded.entity as Record<string, unknown>
      expect(entity.nodeId).toBe('explicit-node')
    })

    it('should track minted tokens in the store', async () => {
      await mintTestToken()
      const tokens = await factory.listTokens()
      expect(tokens).toHaveLength(1)
      expect(tokens[0].entityName).toBe('alice')
    })
  })

  describe('verify', () => {
    it('should verify a freshly minted token as valid', async () => {
      const token = await mintTestToken()
      const result = await factory.verify(token)
      expect(result.valid).toBe(true)
    })

    it('should return payload with entity and roles on success', async () => {
      const token = await mintTestToken()
      const result = await factory.verify(token)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.payload.entity).toBeDefined()
        expect(result.payload.roles).toEqual([Role.USER])
      }
    })

    it('should reject a tampered token', async () => {
      const token = await mintTestToken()
      const tampered = token.slice(0, -5) + 'XXXXX'
      const result = await factory.verify(tampered)
      expect(result.valid).toBe(false)
    })

    it('should reject a revoked token (by JTI)', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)

      await factory.revoke({ jti: decoded.jti! })
      const result = await factory.verify(token)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('Token is revoked')
      }
    })

    it('should reject a revoked token (by SAN)', async () => {
      const token = await mintTestToken({ sans: ['web.example.com'] })

      await factory.revoke({ san: 'web.example.com' })
      const result = await factory.verify(token)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('Token is revoked')
      }
    })
  })

  describe('revoke', () => {
    it('should revoke a token by JTI', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)

      await factory.revoke({ jti: decoded.jti! })
      const tokens = await factory.listTokens()
      expect(tokens[0].revoked).toBe(true)
    })

    it('should revoke tokens by SAN', async () => {
      await mintTestToken({ sans: ['api.internal'] })
      await mintTestToken({
        subject: 'user-2',
        sans: ['api.internal'],
        entity: { id: 'u2', name: 'bob', type: 'user', role: Role.USER },
      })

      await factory.revoke({ san: 'api.internal' })
      const tokens = await factory.listTokens()
      expect(tokens.every((t) => t.revoked)).toBe(true)
    })

    it('should check revocation status via isRevoked()', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)

      expect(await factory.isRevoked(decoded.jti!)).toBe(false)
      await factory.revoke({ jti: decoded.jti! })
      expect(await factory.isRevoked(decoded.jti!)).toBe(true)
    })

    it('should return false for unknown JTI in isRevoked()', async () => {
      expect(await factory.isRevoked('nonexistent-jti')).toBe(false)
    })

    it('should look up token metadata via findToken()', async () => {
      const token = await mintTestToken({ sans: ['node-a.example.com'] })
      const decoded = jose.decodeJwt(token)

      const record = await factory.findToken(decoded.jti!)
      expect(record).not.toBeNull()
      expect(record!.entityName).toBe('alice')
      expect(record!.entityId).toBe('user-1')
      expect(record!.sans).toEqual(['node-a.example.com'])
      expect(record!.revoked).toBe(false)
    })

    it('should return null for unknown JTI in findToken()', async () => {
      const record = await factory.findToken('nonexistent-jti')
      expect(record).toBeNull()
    })

    it('should reflect revocation in findToken() after revoking', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)

      await factory.revoke({ jti: decoded.jti! })
      const record = await factory.findToken(decoded.jti!)
      expect(record).not.toBeNull()
      expect(record!.revoked).toBe(true)
    })
  })

  describe('rotate', () => {
    it('should rotate to a new key and return rotation result', async () => {
      const result = await factory.rotate()
      expect(result.previousKeyId).toBeString()
      expect(result.newKeyId).toBeString()
      expect(result.previousKeyId).not.toBe(result.newKeyId)
    })

    it('should still verify tokens signed with the previous key (grace period)', async () => {
      const token = await mintTestToken()
      await factory.rotate()
      const result = await factory.verify(token)
      expect(result.valid).toBe(true)
    })

    it('should expose both old and new keys in JWKS after rotation', async () => {
      const jwksBefore = await factory.getJwks()
      expect(jwksBefore.keys).toHaveLength(1)

      await factory.rotate()
      const jwksAfter = await factory.getJwks()
      expect(jwksAfter.keys).toHaveLength(2)
    })

    it('should accept immediate rotation (no grace period)', async () => {
      const token = await mintTestToken()
      await factory.rotate({ immediate: true })

      const jwks = await factory.getJwks()
      expect(jwks.keys).toHaveLength(1)

      const result = await factory.verify(token)
      expect(result.valid).toBe(false)
    })
  })

  describe('getJwks', () => {
    it('should return JWKS with current signing key', async () => {
      const jwks = await factory.getJwks()
      expect(jwks.keys).toHaveLength(1)
      expect(jwks.keys[0].alg).toBe('ES384')
      expect(jwks.keys[0].use).toBe('sig')
    })
  })

  describe('introspection', () => {
    it('should list all tracked tokens', async () => {
      await mintTestToken()
      await mintTestToken({
        subject: 'user-2',
        entity: { id: 'u2', name: 'bob', type: 'user', role: Role.USER },
      })

      const tokens = await factory.listTokens()
      expect(tokens).toHaveLength(2)
    })

    it('should filter tokens by certificate fingerprint', async () => {
      await mintTestToken({ certificateFingerprint: 'sha256-abc' })
      await mintTestToken({
        subject: 'user-2',
        entity: { id: 'u2', name: 'bob', type: 'user', role: Role.USER },
      })

      const filtered = await factory.listTokens({ certificateFingerprint: 'sha256-abc' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].entityName).toBe('alice')
    })

    it('should filter tokens by SAN', async () => {
      await mintTestToken({ sans: ['api.example.com'] })
      await mintTestToken({
        subject: 'user-2',
        sans: ['web.example.com'],
        entity: { id: 'u2', name: 'bob', type: 'user', role: Role.USER },
      })

      const filtered = await factory.listTokens({ san: 'api.example.com' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].entityName).toBe('alice')
    })

    it('should return revocation list of unexpired revoked JTIs', async () => {
      const token = await mintTestToken()
      const decoded = jose.decodeJwt(token)

      await factory.revoke({ jti: decoded.jti! })
      const revoked = await factory.getRevocationList()
      expect(revoked).toContain(decoded.jti!)
    })
  })

  describe('escape hatches', () => {
    it('should expose the underlying key manager', () => {
      const km = factory.getKeyManager()
      expect(km).toBeDefined()
      expect(km.isInitialized()).toBe(true)
    })

    it('should expose the underlying token manager', async () => {
      const tm = factory.getTokenManager()
      expect(tm).toBeDefined()

      const store = tm.getStore()
      expect(store).toBeDefined()
    })
  })

  describe('constructor with explicit config', () => {
    it('should work with default config (no arguments)', async () => {
      // This creates real SQLite files — use temp paths
      const f = JWTTokenFactory.ephemeral()
      await f.initialize()

      const token = await f.mint({
        subject: 'test',
        roles: [Role.USER],
        entity: { id: 't1', name: 'test', type: 'user', role: Role.USER },
      })

      const result = await f.verify(token)
      expect(result.valid).toBe(true)

      await f.shutdown()
    })
  })
})
