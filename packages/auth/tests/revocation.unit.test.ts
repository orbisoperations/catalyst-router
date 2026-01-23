import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'

import { generateKeyPair, type KeyPair } from '../src/keys.js'
import { signToken, decodeToken, CLOCK_TOLERANCE } from '../src/jwt.js'
import { InMemoryRevocationStore, revokeToken } from '../src/revocation.js'

const CLOCK_TOLERANCE_MS = CLOCK_TOLERANCE * 1000
const WELL_EXPIRED = CLOCK_TOLERANCE_MS + 5000

describe('RevocationStore', () => {
  let keyPair: KeyPair

  beforeAll(async () => {
    keyPair = await generateKeyPair()
  })

  describe('InMemoryRevocationStore', () => {
    let store: InMemoryRevocationStore

    beforeEach(() => {
      store = new InMemoryRevocationStore()
    })

    it('should track revoked JTIs', () => {
      const expiresAt = new Date(Date.now() + 3600000)
      expect(store.size).toBe(0)
      expect(store.isRevoked('nonexistent')).toBe(false)

      store.revoke('jti-1', expiresAt)
      store.revoke('jti-2', expiresAt)

      expect(store.size).toBe(2)
      expect(store.isRevoked('jti-1')).toBe(true)
      expect(store.isRevoked('jti-2')).toBe(true)
      expect(store.isRevoked('jti-3')).toBe(false)
    })

    it('should handle expiry with clock tolerance', () => {
      const wellExpired = new Date(Date.now() - WELL_EXPIRED)
      const recentlyExpired = new Date(Date.now() - 1000) // within tolerance
      const valid = new Date(Date.now() + 3600000)

      store.revoke('expired', wellExpired)
      store.revoke('recent', recentlyExpired)
      store.revoke('valid', valid)
      expect(store.size).toBe(3)

      // Well-expired returns false AND gets deleted immediately
      expect(store.isRevoked('expired')).toBe(false)
      expect(store.size).toBe(2)

      // Recently expired within tolerance should still be revoked
      expect(store.isRevoked('recent')).toBe(true)
      expect(store.isRevoked('valid')).toBe(true)

      // Cleanup has nothing left to remove
      const removed = store.cleanup()
      expect(removed).toBe(0)
      expect(store.size).toBe(2)
    })

    it('should enforce maxSize with auto-cleanup and eviction', () => {
      const smallStore = new InMemoryRevocationStore({ maxSize: 2 })
      const expired = new Date(Date.now() - WELL_EXPIRED)
      const soonExp = new Date(Date.now() + 1000)
      const laterExp = new Date(Date.now() + 3600000)

      expect(smallStore.maxSize).toBe(2)

      smallStore.revoke('expired', expired)
      smallStore.revoke('valid-1', laterExp)
      expect(smallStore.size).toBe(2)

      // Should auto-cleanup expired and make room
      smallStore.revoke('valid-2', laterExp)
      expect(smallStore.size).toBe(2)
      expect(smallStore.isRevoked('valid-1')).toBe(true)
      expect(smallStore.isRevoked('valid-2')).toBe(true)

      // When at capacity with no expired entries, evicts soonest-to-expire
      smallStore.revoke('soon', soonExp)
      expect(smallStore.size).toBe(2)
      smallStore.revoke('valid-3', laterExp)
      expect(smallStore.size).toBe(2)
      // 'soon' should have been evicted (earliest expiry)
      expect(smallStore.isRevoked('soon')).toBe(false)
      expect(smallStore.isRevoked('valid-3')).toBe(true)
    })
  })

  describe('revokeToken authorization', () => {
    let store: InMemoryRevocationStore

    beforeEach(() => {
      store = new InMemoryRevocationStore()
    })

    it('should allow user to revoke own token', async () => {
      const userToken = await signToken(keyPair, { subject: 'user-123' })
      const authToken = await signToken(keyPair, { subject: 'user-123' })

      const result = await revokeToken({ store, keyPair, token: userToken, authToken })
      expect(result.success).toBe(true)

      const decoded = decodeToken(userToken)
      expect(store.isRevoked(decoded!.payload.jti as string)).toBe(true)
    })

    it('should deny user from revoking other users token', async () => {
      const otherToken = await signToken(keyPair, { subject: 'user-456' })
      const authToken = await signToken(keyPair, { subject: 'user-123' })

      const result = await revokeToken({ store, keyPair, token: otherToken, authToken })
      expect(result.success).toBe(false)
      expect((result as any).error).toBe('Not authorized to revoke this token')
    })

    it('should allow admin to revoke any token', async () => {
      const userToken = await signToken(keyPair, { subject: 'user-123' })
      const adminToken = await signToken(keyPair, {
        subject: 'admin-1',
        claims: { role: 'admin' },
      })

      const result = await revokeToken({ store, keyPair, token: userToken, authToken: adminToken })
      expect(result.success).toBe(true)
    })

    it('should reject invalid auth tokens', async () => {
      const userToken = await signToken(keyPair, { subject: 'user-123' })
      const otherKeyPair = await generateKeyPair()
      const wrongKeyToken = await signToken(otherKeyPair, { subject: 'user-123' })

      // Garbage auth token
      let result = await revokeToken({ store, keyPair, token: userToken, authToken: 'garbage' })
      expect(result.success).toBe(false)
      expect((result as any).error).toBe('Invalid auth token')

      // Auth token signed with wrong key
      result = await revokeToken({ store, keyPair, token: userToken, authToken: wrongKeyToken })
      expect(result.success).toBe(false)
      expect((result as any).error).toBe('Invalid auth token')

      // Malformed target token (not a JWT at all)
      const validAuth = await signToken(keyPair, { subject: 'user-123' })
      result = await revokeToken({ store, keyPair, token: 'not-a-jwt', authToken: validAuth })
      expect(result.success).toBe(false)
      expect((result as any).error).toBe('Malformed token')
    })

    it('should allow revoking tokens signed with different keys', async () => {
      // This is important: we only verify auth token, not target token
      // So tokens signed with rotated/different keys can still be revoked
      const otherKeyPair = await generateKeyPair()
      const wrongKeyToken = await signToken(otherKeyPair, { subject: 'user-123' })
      const validAuth = await signToken(keyPair, { subject: 'user-123' })

      const result = await revokeToken({
        store,
        keyPair,
        token: wrongKeyToken,
        authToken: validAuth,
      })
      expect(result.success).toBe(true)

      const decoded = decodeToken(wrongKeyToken)
      expect(store.isRevoked(decoded!.payload.jti as string)).toBe(true)
    })
  })
})
