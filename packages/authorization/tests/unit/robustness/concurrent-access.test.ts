import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteTokenStore } from '../../../src/jwt/local/sqlite-store.js'
import type { TokenRecord } from '../../../src/jwt/index.js'

/**
 * Concurrent Access Robustness Tests
 *
 * Tests that the token store handles concurrent operations correctly:
 * - Race conditions in token recording
 * - Concurrent revocations
 * - Parallel reads during writes
 * - Token listing consistency
 */
describe('Concurrent Access Robustness', () => {
  let store: SqliteTokenStore

  beforeEach(() => {
    store = new SqliteTokenStore(':memory:')
  })

  describe('concurrent token recording', () => {
    it('should handle 100 concurrent token insertions', async () => {
      const tokens: TokenRecord[] = Array.from({ length: 100 }, (_, i) => ({
        jti: `token-${i}`,
        expiry: Date.now() + 3600000,
        sans: [`user-${i}@example.com`],
        entityId: `entity-${i}`,
        entityName: `Entity ${i}`,
        entityType: 'user',
        revoked: false,
      }))

      // Record all tokens concurrently
      await Promise.all(tokens.map((token) => store.recordToken(token)))

      // Verify all tokens were recorded
      for (const token of tokens) {
        const found = await store.findToken(token.jti)
        expect(found).not.toBeNull()
        expect(found?.jti).toBe(token.jti)
      }
    })

    it('should handle duplicate JTI attempts gracefully', async () => {
      const token: TokenRecord = {
        jti: 'duplicate-jti',
        expiry: Date.now() + 3600000,
        sans: ['user@example.com'],
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: false,
      }

      // First insert should succeed
      await store.recordToken(token)

      // Second insert with same JTI should fail
      await expect(store.recordToken(token)).rejects.toThrow()
    })

    it('should handle concurrent insertions with same entity but different JTIs', async () => {
      const tokens: TokenRecord[] = Array.from({ length: 50 }, (_, i) => ({
        jti: `token-${i}`,
        expiry: Date.now() + 3600000,
        sans: ['user@example.com'], // Same user, different tokens
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: false,
      }))

      await Promise.all(tokens.map((token) => store.recordToken(token)))

      // All tokens should be recorded
      const allTokens = await store.listTokens()
      expect(allTokens).toHaveLength(50)
    })
  })

  describe('concurrent revocations', () => {
    it('should handle concurrent revocations of different tokens', async () => {
      // Create 50 tokens
      const tokens: TokenRecord[] = Array.from({ length: 50 }, (_, i) => ({
        jti: `token-${i}`,
        expiry: Date.now() + 3600000,
        sans: [`user-${i}@example.com`],
        entityId: `entity-${i}`,
        entityName: `Entity ${i}`,
        entityType: 'user',
        revoked: false,
      }))

      for (const token of tokens) {
        await store.recordToken(token)
      }

      // Revoke all concurrently
      await Promise.all(tokens.map((token) => store.revokeToken(token.jti)))

      // Verify all are revoked
      for (const token of tokens) {
        const isRevoked = await store.isRevoked(token.jti)
        expect(isRevoked).toBe(true)
      }
    })

    it('should handle concurrent revocations of same token', async () => {
      const token: TokenRecord = {
        jti: 'token-to-revoke',
        expiry: Date.now() + 3600000,
        sans: ['user@example.com'],
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: false,
      }

      await store.recordToken(token)

      // Attempt to revoke same token 10 times concurrently
      await Promise.all(Array.from({ length: 10 }, () => store.revokeToken(token.jti)))

      // Should be revoked exactly once
      const isRevoked = await store.isRevoked(token.jti)
      expect(isRevoked).toBe(true)

      const found = await store.findToken(token.jti)
      expect(found?.revoked).toBe(true)
    })

    it('should handle concurrent revokeBySan operations', async () => {
      const tokens: TokenRecord[] = [
        {
          jti: 'token-1',
          expiry: Date.now() + 3600000,
          sans: ['user@example.com', 'admin@example.com'],
          entityId: 'entity-1',
          entityName: 'Entity 1',
          entityType: 'user',
          revoked: false,
        },
        {
          jti: 'token-2',
          expiry: Date.now() + 3600000,
          sans: ['user@example.com'],
          entityId: 'entity-2',
          entityName: 'Entity 2',
          entityType: 'user',
          revoked: false,
        },
        {
          jti: 'token-3',
          expiry: Date.now() + 3600000,
          sans: ['other@example.com'],
          entityId: 'entity-3',
          entityName: 'Entity 3',
          entityType: 'user',
          revoked: false,
        },
      ]

      for (const token of tokens) {
        await store.recordToken(token)
      }

      // Revoke by SAN concurrently
      await Promise.all([
        store.revokeBySan('user@example.com'),
        store.revokeBySan('admin@example.com'),
      ])

      // Tokens 1 and 2 should be revoked (contain user@example.com)
      expect(await store.isRevoked('token-1')).toBe(true)
      expect(await store.isRevoked('token-2')).toBe(true)
      // Token 3 should not be revoked
      expect(await store.isRevoked('token-3')).toBe(false)
    })
  })

  describe('concurrent reads and writes', () => {
    it('should handle mixed read/write operations', async () => {
      // Seed some initial tokens
      const initialTokens: TokenRecord[] = Array.from({ length: 20 }, (_, i) => ({
        jti: `initial-${i}`,
        expiry: Date.now() + 3600000,
        sans: [`user-${i}@example.com`],
        entityId: `entity-${i}`,
        entityName: `Entity ${i}`,
        entityType: 'user',
        revoked: false,
      }))

      for (const token of initialTokens) {
        await store.recordToken(token)
      }

      // Mix of operations
      const operations = [
        // Reads
        ...Array.from({ length: 30 }, (_, i) => store.findToken(`initial-${i % 20}`)),
        ...Array.from({ length: 30 }, (_, i) => store.isRevoked(`initial-${i % 20}`)),

        // Writes
        ...Array.from({ length: 20 }, (_, i) =>
          store.recordToken({
            jti: `new-${i}`,
            expiry: Date.now() + 3600000,
            sans: [`new-user-${i}@example.com`],
            entityId: `new-entity-${i}`,
            entityName: `New Entity ${i}`,
            entityType: 'user',
            revoked: false,
          })
        ),

        // Revocations
        ...Array.from({ length: 10 }, (_, i) => store.revokeToken(`initial-${i}`)),
      ]

      // Execute all concurrently
      const results = await Promise.allSettled(operations)

      // Count successes
      const successes = results.filter((r) => r.status === 'fulfilled').length

      // Most operations should succeed (some reads might be null, which is ok)
      expect(successes).toBeGreaterThan(70)
    })

    it('should maintain consistency during high-throughput operations', async () => {
      const iterations = 100

      // Concurrent insertions and reads
      const operations = Array.from({ length: iterations }, (_, i) => {
        const token: TokenRecord = {
          jti: `token-${i}`,
          expiry: Date.now() + 3600000,
          sans: [`user-${i}@example.com`],
          entityId: `entity-${i}`,
          entityName: `Entity ${i}`,
          entityType: 'user',
          revoked: false,
        }

        return store.recordToken(token).then(() => store.findToken(token.jti))
      })

      const results = await Promise.all(operations)

      // All tokens should be found
      expect(results.filter((r) => r !== null)).toHaveLength(iterations)
    })
  })

  describe('concurrent token listing', () => {
    it('should handle concurrent listTokens calls', async () => {
      // Seed tokens
      const tokens: TokenRecord[] = Array.from({ length: 50 }, (_, i) => ({
        jti: `token-${i}`,
        expiry: Date.now() + 3600000,
        cfn: i % 2 === 0 ? 'fingerprint-a' : 'fingerprint-b',
        sans: [`user-${i}@example.com`],
        entityId: `entity-${i}`,
        entityName: `Entity ${i}`,
        entityType: 'user',
        revoked: false,
      }))

      for (const token of tokens) {
        await store.recordToken(token)
      }

      // List concurrently with different filters
      const [all, withFingerprintA, withFingerprintB, withSan] = await Promise.all([
        store.listTokens(),
        store.listTokens({ certificateFingerprint: 'fingerprint-a' }),
        store.listTokens({ certificateFingerprint: 'fingerprint-b' }),
        store.listTokens({ san: 'user-5@example.com' }),
      ])

      expect(all).toHaveLength(50)
      expect(withFingerprintA).toHaveLength(25)
      expect(withFingerprintB).toHaveLength(25)
      expect(withSan.length).toBeGreaterThan(0)
    })
  })

  describe('revocation list consistency', () => {
    it('should maintain accurate revocation list during concurrent operations', async () => {
      const tokens: TokenRecord[] = Array.from({ length: 30 }, (_, i) => ({
        jti: `token-${i}`,
        expiry: Date.now() + 3600000,
        sans: [`user-${i}@example.com`],
        entityId: `entity-${i}`,
        entityName: `Entity ${i}`,
        entityType: 'user',
        revoked: false,
      }))

      // Record all tokens
      for (const token of tokens) {
        await store.recordToken(token)
      }

      // Revoke half concurrently
      await Promise.all(tokens.slice(0, 15).map((token) => store.revokeToken(token.jti)))

      const revocationList = await store.getRevocationList()

      // Should have exactly 15 revoked tokens
      expect(revocationList).toHaveLength(15)

      // All revoked JTIs should be in the list
      for (let i = 0; i < 15; i++) {
        expect(revocationList).toContain(`token-${i}`)
      }
    })
  })

  describe('stress test', () => {
    it('should handle 1000 mixed operations', async () => {
      // Sequential batches to ensure operations make sense

      // Batch 1: Insert 400 tokens
      const insertions = Array.from({ length: 400 }, (_, i) =>
        store.recordToken({
          jti: `stress-token-${i}`,
          expiry: Date.now() + 3600000,
          sans: [`user-${i}@example.com`],
          entityId: `entity-${i}`,
          entityName: `Entity ${i}`,
          entityType: 'user',
          revoked: false,
        })
      )
      await Promise.all(insertions)

      // Batch 2: Mix of reads, revocations, and lists
      const mixedOps = [
        // 300 reads
        ...Array.from({ length: 300 }, (_, i) => store.findToken(`stress-token-${i % 400}`)),
        // 200 revocations
        ...Array.from({ length: 200 }, (_, i) => store.revokeToken(`stress-token-${i}`)),
        // 100 list operations
        ...Array.from({ length: 100 }, () => store.listTokens()),
      ]

      const results = await Promise.allSettled(mixedOps)

      const successes = results.filter((r) => r.status === 'fulfilled').length

      // All should succeed
      expect(successes).toBe(600)
    })
  })
})
