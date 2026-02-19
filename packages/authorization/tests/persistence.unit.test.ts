import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteTokenStore, SqliteKeyStore, PersistentLocalKeyManager } from '../src/index.js'

describe('Authorization Persistence', () => {
  describe('SqliteTokenStore', () => {
    let store: SqliteTokenStore

    beforeEach(() => {
      store = new SqliteTokenStore(':memory:')
    })

    it('should record and find tokens', async () => {
      const record = {
        jti: 'test-jti',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        sans: ['web.example.com'],
        entityId: 'user1',
        entityName: 'User One',
        entityType: 'user' as const,
        revoked: false,
      }

      await store.recordToken(record)
      const found = await store.findToken('test-jti')
      expect(found).toEqual(record)
    })

    it('should revoke tokens by JTI', async () => {
      await store.recordToken({
        jti: 'jti1',
        expiry: 9999999999,
        sans: [],
        entityId: 'e1',
        entityName: 'n1',
        entityType: 'service' as const,
        revoked: false,
      })

      expect(await store.isRevoked('jti1')).toBe(false)
      await store.revokeToken('jti1')
      expect(await store.isRevoked('jti1')).toBe(true)
    })

    it('should revoke tokens by SAN', async () => {
      await store.recordToken({
        jti: 'jti2',
        expiry: 9999999999,
        sans: ['app1.internal'],
        entityId: 'e2',
        entityName: 'n2',
        entityType: 'service' as const,
        revoked: false,
      })

      expect(await store.isRevoked('jti2')).toBe(false)
      await store.revokeBySan('app1.internal')
      expect(await store.isRevoked('jti2')).toBe(true)
    })

    it('should list tokens with filters', async () => {
      await store.recordToken({
        jti: 't1',
        expiry: 9999999999,
        cfn: 'cert1',
        sans: ['san1'],
        entityId: 'e1',
        entityName: 'n1',
        entityType: 'service' as const,
        revoked: false,
      })

      const byCert = await store.listTokens({ certificateFingerprint: 'cert1' })
      expect(byCert).toHaveLength(1)
      expect(byCert[0].jti).toBe('t1')

      const bySan = await store.listTokens({ san: 'san1' })
      expect(bySan).toHaveLength(1)
      expect(bySan[0].jti).toBe('t1')
    })
  })

  describe('SqliteKeyStore and PersistentLocalKeyManager', () => {
    it('should persist and reload keys', async () => {
      const keyStore = new SqliteKeyStore(':memory:')
      const manager1 = new PersistentLocalKeyManager(keyStore)
      await manager1.initialize()

      const kid1 = await manager1.getCurrentKeyId()

      // Second manager using same store should see same kid
      const manager2 = new PersistentLocalKeyManager(keyStore)
      await manager2.initialize()
      const kid2 = await manager2.getCurrentKeyId()

      expect(kid1).toBe(kid2)
    })

    it('should handle rotation with persistence', async () => {
      const keyStore = new SqliteKeyStore(':memory:')
      const manager = new PersistentLocalKeyManager(keyStore)
      await manager.initialize()

      const oldKid = await manager.getCurrentKeyId()
      await manager.rotate({ immediate: false })
      const newKid = await manager.getCurrentKeyId()

      expect(oldKid).not.toBe(newKid)

      // Verify both kids are in JWKS
      const jwks = await manager.getJwks()
      const kids = jwks.keys.map((k) => k.kid)
      expect(kids).toContain(oldKid)
      expect(kids).toContain(newKid)

      // Reload and verify
      const manager2 = new PersistentLocalKeyManager(keyStore)
      await manager2.initialize()
      expect(await manager2.getCurrentKeyId()).toBe(newKid)
    })
  })
})
