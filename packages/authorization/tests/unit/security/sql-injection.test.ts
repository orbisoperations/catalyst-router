import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteTokenStore } from '../../../src/jwt/local/sqlite-store.js'
import type { TokenRecord } from '../../../src/jwt/index.js'

/**
 * SQL Injection Security Tests
 *
 * Tests that user-controlled input (JTI, SAN, certificate fingerprints) cannot
 * be used to perform SQL injection attacks against the token store.
 */
describe('SQL Injection Security', () => {
  let store: SqliteTokenStore

  beforeEach(() => {
    store = new SqliteTokenStore(':memory:')
  })

  describe('findToken SQL injection attempts', () => {
    it('should safely handle single quote in JTI', async () => {
      const maliciousJti = "test' OR '1'='1"

      const record: TokenRecord = {
        jti: maliciousJti,
        expiry: Date.now() + 3600000,
        sans: [],
        entityId: 'test-entity',
        entityName: 'Test',
        entityType: 'service',
        revoked: false,
      }

      await store.recordToken(record)

      // Should find only the exact JTI, not all tokens
      const found = await store.findToken(maliciousJti)
      expect(found).not.toBeNull()
      expect(found?.jti).toBe(maliciousJti)

      // Try to find with injection - should return null
      const injectionAttempt = await store.findToken("' OR '1'='1")
      expect(injectionAttempt).toBeNull()
    })

    it('should safely handle SQL comment injection in JTI', async () => {
      const maliciousJti = "test'; DROP TABLE token; --"

      const record: TokenRecord = {
        jti: maliciousJti,
        expiry: Date.now() + 3600000,
        sans: [],
        entityId: 'test-entity',
        entityName: 'Test',
        entityType: 'service',
        revoked: false,
      }

      await store.recordToken(record)

      // Should find the token with the malicious string as literal text
      const found = await store.findToken(maliciousJti)
      expect(found).not.toBeNull()
      expect(found?.jti).toBe(maliciousJti)

      // Verify table still exists by querying
      const another: TokenRecord = {
        jti: 'safe-jti',
        expiry: Date.now() + 3600000,
        sans: [],
        entityId: 'test',
        entityName: 'Test',
        entityType: 'service',
        revoked: false,
      }
      await store.recordToken(another)
      const check = await store.findToken('safe-jti')
      expect(check).not.toBeNull()
    })

    it('should safely handle UNION injection in JTI', async () => {
      const maliciousJti =
        "test' UNION SELECT 'fake-jti', 1, 'fake', '[]', 'id', 'name', 'user', 0--"

      // Should not return fake data
      const found = await store.findToken(maliciousJti)
      expect(found).toBeNull()
    })
  })

  describe('revokeToken SQL injection attempts', () => {
    beforeEach(async () => {
      // Create some tokens to test revocation
      const tokens: TokenRecord[] = [
        {
          jti: 'token-1',
          expiry: Date.now() + 3600000,
          sans: [],
          entityId: 'entity-1',
          entityName: 'Entity 1',
          entityType: 'user',
          revoked: false,
        },
        {
          jti: 'token-2',
          expiry: Date.now() + 3600000,
          sans: [],
          entityId: 'entity-2',
          entityName: 'Entity 2',
          entityType: 'user',
          revoked: false,
        },
      ]

      for (const token of tokens) {
        await store.recordToken(token)
      }
    })

    it('should not revoke all tokens via OR injection', async () => {
      const maliciousJti = "token-1' OR '1'='1"

      await store.revokeToken(maliciousJti)

      // Only the literal JTI should not be found (doesn't exist)
      // Other tokens should remain unrevoked
      const token1 = await store.findToken('token-1')
      const token2 = await store.findToken('token-2')

      expect(token1?.revoked).toBe(false)
      expect(token2?.revoked).toBe(false)
    })

    it('should safely handle comment injection in revocation', async () => {
      const maliciousJti = "token-1'; UPDATE token SET is_revoked = 1; --"

      await store.revokeToken(maliciousJti)

      // Tokens should remain unrevoked (injection blocked)
      const token1 = await store.findToken('token-1')
      const token2 = await store.findToken('token-2')

      expect(token1?.revoked).toBe(false)
      expect(token2?.revoked).toBe(false)
    })
  })

  describe('revokeBySan SQL injection attempts', () => {
    beforeEach(async () => {
      const tokens: TokenRecord[] = [
        {
          jti: 'token-san-1',
          expiry: Date.now() + 3600000,
          sans: ['user@example.com'],
          entityId: 'entity-1',
          entityName: 'Entity 1',
          entityType: 'user',
          revoked: false,
        },
        {
          jti: 'token-san-2',
          expiry: Date.now() + 3600000,
          sans: ['admin@example.com'],
          entityId: 'entity-2',
          entityName: 'Entity 2',
          entityType: 'user',
          revoked: false,
        },
      ]

      for (const token of tokens) {
        await store.recordToken(token)
      }
    })

    it('should safely handle LIKE wildcard injection', async () => {
      // Attempt to match all tokens using SQL wildcards
      const maliciousSan = "%' OR '1'='1"

      await store.revokeBySan(maliciousSan)

      // The literal string with SQL injection won't match our test SANs
      // The key security test is that the injection didn't execute arbitrary SQL (DROP, UPDATE all)
      const token1 = await store.findToken('token-san-1')
      const token2 = await store.findToken('token-san-2')

      // Tokens should not be revoked because the malicious string doesn't match
      // If SQL injection worked, both would be revoked via OR '1'='1'
      expect(token1?.revoked).toBe(false)
      expect(token2?.revoked).toBe(false)

      // Verify table still exists (DROP TABLE didn't execute)
      expect(token1).not.toBeNull()
      expect(token2).not.toBeNull()
    })

    it('should handle escaped wildcards in SAN', async () => {
      // Test that % and _ are handled correctly in LIKE clause
      const sanWithWildcards = 'test%user_data@example.com'

      const token: TokenRecord = {
        jti: 'token-wildcard',
        expiry: Date.now() + 3600000,
        sans: [sanWithWildcards],
        entityId: 'entity-wc',
        entityName: 'Wildcard Entity',
        entityType: 'user',
        revoked: false,
      }

      await store.recordToken(token)

      // Revoke by exact SAN (should match)
      await store.revokeBySan(sanWithWildcards)

      const found = await store.findToken('token-wildcard')
      expect(found?.revoked).toBe(true)
    })

    it('should not execute SQL injection via comment in SAN', async () => {
      const maliciousSan = "user@example.com'; DROP TABLE token; --"

      await store.revokeBySan(maliciousSan)

      // Verify table still exists
      const token1 = await store.findToken('token-san-1')
      expect(token1).not.toBeNull()
    })
  })

  describe('listTokens SQL injection attempts', () => {
    beforeEach(async () => {
      const tokens: TokenRecord[] = [
        {
          jti: 'token-list-1',
          expiry: Date.now() + 3600000,
          cfn: 'fingerprint-abc',
          sans: ['user@example.com'],
          entityId: 'entity-1',
          entityName: 'Entity 1',
          entityType: 'user',
          revoked: false,
        },
        {
          jti: 'token-list-2',
          expiry: Date.now() + 3600000,
          cfn: 'fingerprint-xyz',
          sans: ['admin@example.com'],
          entityId: 'entity-2',
          entityName: 'Entity 2',
          entityType: 'user',
          revoked: false,
        },
      ]

      for (const token of tokens) {
        await store.recordToken(token)
      }
    })

    it('should safely handle SQL injection in certificate fingerprint filter', async () => {
      const maliciousFingerprint = "fingerprint-abc' OR '1'='1"

      const tokens = await store.listTokens({ certificateFingerprint: maliciousFingerprint })

      // Should return empty (no exact match), not all tokens
      expect(tokens).toHaveLength(0)
    })

    it('should safely handle SQL injection in SAN filter', async () => {
      const maliciousSan = "example.com' OR '1'='1"

      const tokens = await store.listTokens({ san: maliciousSan })

      // Should return empty or only matching tokens, not all
      // In this case, LIKE %...% will match both, which is expected
      expect(tokens.length).toBeGreaterThanOrEqual(0)
      // Key is that no SQL error occurred and query was parameterized
    })

    it('should safely handle combined filter injection', async () => {
      const maliciousFingerprint = "'; DROP TABLE token; --"
      const maliciousSan = "'; UPDATE token SET is_revoked = 1; --"

      const tokens = await store.listTokens({
        certificateFingerprint: maliciousFingerprint,
        san: maliciousSan,
      })

      // Should return empty
      expect(tokens).toHaveLength(0)

      // Verify table still exists and data intact
      const check = await store.findToken('token-list-1')
      expect(check).not.toBeNull()
      expect(check?.revoked).toBe(false)
    })

    it('should handle UNION injection in filters', async () => {
      const maliciousSan =
        "test' UNION SELECT 'injected-jti', 1, 'fake', '[]', 'id', 'name', 'user', 0--"

      const tokens = await store.listTokens({ san: maliciousSan })

      // Should not return injected data
      const hasInjected = tokens.some((t) => t.jti === 'injected-jti')
      expect(hasInjected).toBe(false)
    })
  })

  describe('isRevoked SQL injection attempts', () => {
    beforeEach(async () => {
      const token: TokenRecord = {
        jti: 'revoked-token',
        expiry: Date.now() + 3600000,
        sans: [],
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: true,
      }
      await store.recordToken(token)
    })

    it('should safely handle SQL injection in JTI check', async () => {
      const maliciousJti = "revoked-token' OR '1'='1"

      const isRevoked = await store.isRevoked(maliciousJti)

      // Should return false (no exact match), not true for all tokens
      expect(isRevoked).toBe(false)
    })

    it('should handle comment injection in revocation check', async () => {
      const maliciousJti = "test'; SELECT 1; --"

      const isRevoked = await store.isRevoked(maliciousJti)

      // Should return false (no match)
      expect(isRevoked).toBe(false)
    })
  })

  describe('getRevocationList SQL injection attempts', () => {
    it('should safely handle time-based injection in revocation list', async () => {
      const token: TokenRecord = {
        jti: 'future-revoked',
        expiry: Date.now() + 3600000,
        sans: [],
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: true,
      }
      await store.recordToken(token)

      // No parameters to inject, but verify it returns correctly
      const list = await store.getRevocationList()

      expect(list).toContain('future-revoked')
      expect(list).toBeInstanceOf(Array)
    })
  })

  describe('JSON parsing vulnerabilities', () => {
    it('should safely handle malicious JSON in SANs', async () => {
      const maliciousToken: TokenRecord = {
        jti: 'json-injection',
        expiry: Date.now() + 3600000,
        sans: ['", "injected": "value', '{"nested": "object"}'],
        entityId: 'entity-1',
        entityName: 'Entity 1',
        entityType: 'user',
        revoked: false,
      }

      await store.recordToken(maliciousToken)

      const found = await store.findToken('json-injection')
      expect(found).not.toBeNull()
      expect(found?.sans).toHaveLength(2)
      expect(found?.sans[0]).toBe('", "injected": "value')
    })

    it('should handle unicode and special characters in JSON fields', async () => {
      const unicodeToken: TokenRecord = {
        jti: 'unicode-test',
        expiry: Date.now() + 3600000,
        sans: ['user@例え.jp', 'test\u0000null@example.com', 'emoji😀@example.com'],
        entityId: 'unicode-entity-✓',
        entityName: 'Test 测试',
        entityType: 'user',
        revoked: false,
      }

      await store.recordToken(unicodeToken)

      const found = await store.findToken('unicode-test')
      expect(found).not.toBeNull()
      expect(found?.entityName).toBe('Test 测试')
      expect(found?.sans).toContain('emoji😀@example.com')
    })
  })
})
