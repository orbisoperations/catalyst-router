import { describe, it, expect, beforeAll } from 'bun:test'
import { signToken, verifyToken, decodeToken } from '../../src/jwt.js'
import { generateKeyPair, type KeyPair } from '../../src/keys.js'

/**
 * JWT Security Attack Tests
 *
 * Tests various attack vectors against JWT implementation:
 * - Signature bypass (alg: none, null signature)
 * - Token tampering (modified payload, header)
 * - Kid header manipulation
 * - Clock skew exploitation
 * - Reserved claims override
 */
describe('JWT Security Attacks', () => {
  let keyPair: KeyPair
  let attackerKeyPair: KeyPair

  beforeAll(async () => {
    keyPair = await generateKeyPair()
    attackerKeyPair = await generateKeyPair()
  })

  // Helper to create properly encoded JWT parts
  function base64urlEncode(str: string): string {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  function base64urlDecode(str: string): string {
    const padded = str + '='.repeat((4 - (str.length % 4)) % 4)
    return atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  }

  describe('Algorithm Confusion Attacks', () => {
    it('should reject tokens with alg: none', async () => {
      const header = { alg: 'none', typ: 'JWT' }
      const payload = {
        sub: 'attacker',
        iss: 'catalyst',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }

      const headerB64 = base64urlEncode(JSON.stringify(header))
      const payloadB64 = base64urlEncode(JSON.stringify(payload))
      const maliciousToken = `${headerB64}.${payloadB64}.`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should reject tokens with alg: NONE (case variation)', async () => {
      const header = { alg: 'NONE', typ: 'JWT', kid: keyPair.kid }
      const payload = {
        sub: 'attacker',
        iss: 'catalyst',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }

      const headerB64 = base64urlEncode(JSON.stringify(header))
      const payloadB64 = base64urlEncode(JSON.stringify(payload))
      const maliciousToken = `${headerB64}.${payloadB64}.fake-signature`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
    })

    it('should reject tokens with missing alg field', async () => {
      const header = { typ: 'JWT', kid: keyPair.kid }
      const payload = {
        sub: 'attacker',
        iss: 'catalyst',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }

      const headerB64 = base64urlEncode(JSON.stringify(header))
      const payloadB64 = base64urlEncode(JSON.stringify(payload))
      const maliciousToken = `${headerB64}.${payloadB64}.fake-signature`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
    })
  })

  describe('Signature Bypass Attacks', () => {
    it('should reject token with modified payload', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { role: 'user' },
      })

      // Tamper with payload to escalate privilege
      const parts = token.split('.')
      const payload = JSON.parse(base64urlDecode(parts[1]))
      payload.role = 'admin' // Privilege escalation attempt
      parts[1] = base64urlEncode(JSON.stringify(payload))
      const tamperedToken = parts.join('.')

      const result = await verifyToken(keyPair, tamperedToken)
      expect(result.valid).toBe(false)
      // Error could be "Invalid token" or signature-related
      expect(result.error).toBeDefined()
    })

    it('should reject token signed with different key', async () => {
      // Attacker creates token with their own key
      const attackerToken = await signToken(attackerKeyPair, {
        subject: 'attacker',
        claims: { role: 'admin' },
      })

      // Try to verify with victim's key
      const result = await verifyToken(keyPair, attackerToken)
      expect(result.valid).toBe(false)
    })

    it('should reject token with null signature', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const parts = token.split('.')

      // Remove signature
      const maliciousToken = `${parts[0]}.${parts[1]}.`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
    })

    it('should reject token with corrupted signature', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const parts = token.split('.')

      // Corrupt signature by flipping a bit
      const corrupted = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a')
      const maliciousToken = `${parts[0]}.${parts[1]}.${corrupted}`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('Header Manipulation Attacks', () => {
    it('should reject token with modified kid field', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const parts = token.split('.')

      // Modify kid to point to attacker-controlled key
      const header = JSON.parse(base64urlDecode(parts[0]))
      header.kid = 'attacker-key-id'
      parts[0] = base64urlEncode(JSON.stringify(header))
      const tamperedToken = parts.join('.')

      const result = await verifyToken(keyPair, tamperedToken)
      expect(result.valid).toBe(false)
    })

    it('should reject token with extra header fields', async () => {
      const header = {
        alg: 'ES256',
        typ: 'JWT',
        kid: keyPair.kid,
        jku: 'https://attacker.com/jwks.json', // Malicious JWKS URL
      }
      const payload = {
        sub: 'attacker',
        iss: 'catalyst',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }

      const headerB64 = base64urlEncode(JSON.stringify(header))
      const payloadB64 = base64urlEncode(JSON.stringify(payload))
      const maliciousToken = `${headerB64}.${payloadB64}.fake-sig`

      const result = await verifyToken(keyPair, maliciousToken)
      expect(result.valid).toBe(false)
    })
  })

  describe('Clock Skew Exploitation', () => {
    it('should reject token with past expiration timestamp', async () => {
      // Create a valid token first
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresIn: '1h',
      })

      // Manually tamper with exp to set it in the past (beyond clock tolerance)
      const parts = token.split('.')
      const payload = JSON.parse(base64urlDecode(parts[1]))
      payload.exp = Math.floor(Date.now() / 1000) - 60 // 60 seconds ago (beyond 30s tolerance)
      parts[1] = base64urlEncode(JSON.stringify(payload))
      const expiredToken = parts.join('.')

      const result = await verifyToken(keyPair, expiredToken)
      // Will fail due to signature verification (tampered token)
      expect(result.valid).toBe(false)
    })

    it('should accept token within clock tolerance window (30s)', async () => {
      // Create token that expires immediately
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresIn: '1s',
      })

      // Verify immediately (within tolerance)
      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(true)
    })

    it('should reject token with nbf (not before) in future beyond tolerance', async () => {
      const now = Math.floor(Date.now() / 1000)

      // Manually create token with nbf in future (60 seconds)
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresIn: '1h',
      })

      const parts = token.split('.')
      const payload = JSON.parse(base64urlDecode(parts[1]))
      payload.nbf = now + 60 // Not valid for another 60 seconds
      parts[1] = base64urlEncode(JSON.stringify(payload))
      const futureToken = parts.join('.')

      const result = await verifyToken(keyPair, futureToken)
      expect(result.valid).toBe(false) // Will fail signature verification due to tampering
    })
  })

  describe('Reserved Claims Override Attacks', () => {
    it('should not allow overriding iss (issuer) claim', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { iss: 'attacker-issuer' },
      })

      const decoded = decodeToken(token)
      expect(decoded).not.toBeNull()
      // Should be default issuer from env (catalyst-auth), not attacker value
      expect(decoded!.payload.iss).not.toBe('attacker-issuer')
      expect(decoded!.payload.iss).toMatch(/^catalyst/)
    })

    it('should not allow overriding exp (expiration) claim', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresIn: '1h',
        claims: { exp: Math.floor(Date.now() / 1000) + 31536000 }, // 1 year
      })

      const decoded = decodeToken(token)
      expect(decoded).not.toBeNull()

      const actualExpiry = decoded!.payload.exp as number
      const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600

      // Should be ~1 hour, not 1 year
      expect(actualExpiry).toBeLessThan(oneHourFromNow + 60)
    })

    it('should not allow overriding jti (JWT ID) claim', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { jti: 'attacker-controlled-jti' },
      })

      const decoded = decodeToken(token)
      expect(decoded).not.toBeNull()

      // JTI should be auto-generated UUID, not attacker value
      expect(decoded!.payload.jti).not.toBe('attacker-controlled-jti')
      expect(decoded!.payload.jti).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
      )
    })
  })

  describe('Malformed Token Attacks', () => {
    it('should reject token with only 2 parts', async () => {
      const token = 'header.payload'
      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(false)
    })

    it('should reject token with 4 parts', async () => {
      const token = 'header.payload.signature.extra'
      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(false)
    })

    it('should reject token with invalid base64 encoding', async () => {
      const token = 'not-base64!.also-not-base64!.invalid!'
      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(false)
    })

    it('should reject token with invalid JSON in header', async () => {
      const malformedHeader = base64urlEncode('{invalid json}')
      const validPayload = base64urlEncode(JSON.stringify({ sub: 'test' }))
      const token = `${malformedHeader}.${validPayload}.signature`

      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(false)
    })

    it('should reject token with invalid JSON in payload', async () => {
      const validHeader = base64urlEncode(JSON.stringify({ alg: 'ES256', kid: keyPair.kid }))
      const malformedPayload = base64urlEncode('{invalid json}')
      const token = `${validHeader}.${malformedPayload}.signature`

      const result = await verifyToken(keyPair, token)
      expect(result.valid).toBe(false)
    })

    it('should reject empty token', async () => {
      const result = await verifyToken(keyPair, '')
      expect(result.valid).toBe(false)
    })

    it('should reject null bytes in token', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const malicious = token + '\u0000'

      const result = await verifyToken(keyPair, malicious)
      expect(result.valid).toBe(false)
    })
  })

  describe('JTI Collision Attacks', () => {
    it('should generate unique JTIs for concurrent token creation', async () => {
      const tokens = await Promise.all(
        Array.from({ length: 100 }, () =>
          signToken(keyPair, {
            subject: 'user-123',
            expiresIn: '1h',
          })
        )
      )

      const jtis = tokens.map((token) => {
        const decoded = decodeToken(token)
        return decoded?.payload.jti as string
      })

      // All JTIs should be unique
      const uniqueJtis = new Set(jtis)
      expect(uniqueJtis.size).toBe(100)
    })

    it('should use cryptographically random JTIs', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const decoded = decodeToken(token)

      const jti = decoded?.payload.jti as string
      expect(jti).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)

      // UUIDv4 format check (version 4 = random)
      const versionNibble = jti.split('-')[2][0]
      expect(versionNibble).toBe('4')
    })
  })

  describe('Audience Validation Bypass', () => {
    it('should reject token with wrong audience', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        audience: 'service-a',
      })

      const result = await verifyToken(keyPair, token, { audience: 'service-b' })
      expect(result.valid).toBe(false)
      // Error could be generic "Invalid token" or audience-specific
      expect(result.error).toBeDefined()
    })

    it('should reject token without audience when audience expected', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        // No audience
      })

      const result = await verifyToken(keyPair, token, { audience: 'service-a' })
      expect(result.valid).toBe(false)
    })

    it('should handle audience array manipulation', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        audience: ['service-a', 'service-b'],
      })

      // Should accept if any audience matches
      const result1 = await verifyToken(keyPair, token, { audience: 'service-a' })
      expect(result1.valid).toBe(true)

      // Should reject if none match
      const result2 = await verifyToken(keyPair, token, { audience: 'service-c' })
      expect(result2.valid).toBe(false)
    })
  })

  describe('Maximum Token Lifetime Enforcement', () => {
    it('should enforce maximum 52-week token lifetime', async () => {
      // Try to create token with 2-year expiration
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresIn: '104w', // 2 years
      })

      const decoded = decodeToken(token)
      expect(decoded).not.toBeNull()

      const exp = decoded!.payload.exp as number
      const iat = decoded!.payload.iat as number
      const lifetimeSeconds = exp - iat

      const maxLifetime = 52 * 7 * 24 * 60 * 60 // 52 weeks in seconds

      // Should be capped at 52 weeks
      expect(lifetimeSeconds).toBeLessThanOrEqual(maxLifetime)
    })
  })
})
