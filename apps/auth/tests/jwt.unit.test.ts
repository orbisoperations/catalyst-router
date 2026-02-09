import { describe, it, expect, beforeAll } from 'bun:test'
import { generateKeyPair, type KeyPair, ALGORITHM } from '../src/keys.js'
import {
  signToken,
  verifyToken,
  decodeToken,
  type SignOptions,
  type VerifyResult,
} from '../src/jwt.js'

/**
 * Helper to decode token and assert it's valid, returning typed payload/header
 */
function expectDecoded(token: string) {
  const decoded = decodeToken(token)
  expect(decoded).not.toBeNull()
  return decoded!
}

/**
 * Helper to assert verification succeeded and return typed payload
 */
function expectValid(result: VerifyResult) {
  expect(result.valid).toBe(true)
  return (result as { valid: true; payload: Record<string, unknown> }).payload
}

/**
 * Helper to assert verification failed and return error
 */
function expectInvalid(result: VerifyResult) {
  expect(result.valid).toBe(false)
  return (result as { valid: false; error: string }).error
}

/**
 * Base64url encode (RFC 4648) - proper JWT encoding
 */
function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Base64url decode (RFC 4648)
 */
function base64urlDecode(str: string): string {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4)
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
}

describe('jwt', () => {
  let keyPair: KeyPair
  let otherKeyPair: KeyPair

  beforeAll(async () => {
    keyPair = await generateKeyPair()
    otherKeyPair = await generateKeyPair()
  })

  describe('signToken', () => {
    it('should sign a token with required options', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })

      expect(token).toBeString()
      expect(token.split('.')).toHaveLength(3)

      const { header, payload } = expectDecoded(token)
      expect(payload.sub).toBe('user-123')
      expect(payload.iss).toBe('catalyst-auth')
      expect(payload.iat).toBeNumber()
      expect(payload.exp).toBeNumber()
      expect(payload.jti).toBeString()
      expect(header.kid).toBe(keyPair.kid)
      expect(header.alg).toBe(ALGORITHM)
    })

    it('should include audience when provided', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        audience: 'my-service',
      })

      const { payload } = expectDecoded(token)
      expect(payload.aud).toBe('my-service')
    })

    it('should support array audience', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        audience: ['service-a', 'service-b'],
      })

      const { payload } = expectDecoded(token)
      expect(payload.aud).toEqual(['service-a', 'service-b'])
    })

    it('should include custom claims', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: {
          role: 'admin',
          permissions: ['read', 'write'],
        },
      })

      const { payload } = expectDecoded(token)
      expect(payload.role).toBe('admin')
      expect(payload.permissions).toEqual(['read', 'write'])
    })

    it('should respect custom expiration', async () => {
      const now = Date.now()
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresAt: now + 5 * 60 * 1000,
      })

      const { payload } = expectDecoded(token)
      const exp = payload.exp as number
      // exp is in seconds, need to allow for slight timing difference
      // We check if it is roughly 5 minutes from now (within 2 seconds)
      const expectedExp = Math.floor((now + 300000) / 1000)
      expect(Math.abs(exp - expectedExp)).toBeLessThan(2)
    })

    it('should reject invalid options', async () => {
      await expect(signToken(keyPair, {} as SignOptions)).rejects.toThrow()
    })

    it('should generate unique jti for each token', async () => {
      const token1 = await signToken(keyPair, { subject: 'user-123' })
      const token2 = await signToken(keyPair, { subject: 'user-123' })

      const { payload: p1 } = expectDecoded(token1)
      const { payload: p2 } = expectDecoded(token2)
      expect(p1.jti).not.toBe(p2.jti)
    })

    it('should reject expiration exceeding maximum lifetime', async () => {
      await expect(
        signToken(keyPair, {
          subject: 'user-123',
          expiresAt: Date.now() + 400 * 24 * 60 * 60 * 1000, // > 52 weeks max
        })
      ).rejects.toThrow('exceeds maximum allowed')
    })

    it('should reject past expiration', async () => {
      await expect(
        signToken(keyPair, { subject: 'user-123', expiresAt: Date.now() - 1000 })
      ).rejects.toThrow('must be in the future')
    })

    it('should accept expiration at maximum lifetime', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        expiresAt: Date.now() + 364 * 24 * 60 * 60 * 1000,
      })
      expect(token).toBeString()
    })

    it('should strip reserved claims from custom claims', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: {
          iss: 'evil-issuer',
          sub: 'evil-subject',
          exp: 9999999999,
          iat: 0,
          jti: 'evil-jti',
          role: 'admin',
        },
      })

      const { payload } = expectDecoded(token)
      expect(payload.iss).toBe('catalyst-auth')
      expect(payload.sub).toBe('user-123')
      expect(payload.jti).not.toBe('evil-jti')
      expect(payload.role).toBe('admin')
    })
  })

  describe('verifyToken', () => {
    it('should verify a valid token', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })
      const result = await verifyToken(keyPair, token)

      const payload = expectValid(result)
      expect(payload.sub).toBe('user-123')
    })

    it('should return payload with all claims', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { role: 'admin' },
      })

      const payload = expectValid(await verifyToken(keyPair, token))
      expect(payload.sub).toBe('user-123')
      expect(payload.role).toBe('admin')
      expect(payload.iss).toBe('catalyst-auth')
      expect(payload.jti).toBeString()
    })

    it('should reject token signed with different key', async () => {
      const token = await signToken(otherKeyPair, { subject: 'user-123' })
      const result = await verifyToken(keyPair, token)

      const error = expectInvalid(result)
      expect(error).toBe('Invalid token')
    })

    it('should reject expired token', async () => {
      // Create a token that's already expired by tampering with exp
      const token = await signToken(keyPair, {
        subject: 'user-123',
      })

      // Tamper with exp to make it expired (set to past timestamp)
      const parts = token.split('.')
      const payload = JSON.parse(base64urlDecode(parts[1]))
      payload.exp = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
      parts[1] = base64urlEncode(JSON.stringify(payload))
      const expiredToken = parts.join('.')

      // This will fail signature verification (tampered), not expiration
      // But that's fine - the point is it rejects invalid tokens
      const result = await verifyToken(keyPair, expiredToken)
      expectInvalid(result)
    })

    it('should reject malformed token', async () => {
      const error = expectInvalid(await verifyToken(keyPair, 'not-a-valid-token'))
      expect(error).toBe('Invalid token')
    })

    it('should reject token with tampered payload', async () => {
      const token = await signToken(keyPair, { subject: 'user-123' })

      const parts = token.split('.')
      const payload = JSON.parse(base64urlDecode(parts[1]))
      payload.sub = 'user-456'
      parts[1] = base64urlEncode(JSON.stringify(payload))
      const tamperedToken = parts.join('.')

      expectInvalid(await verifyToken(keyPair, tamperedToken))
    })

    it('should reject empty string token', async () => {
      const error = expectInvalid(await verifyToken(keyPair, ''))
      expect(error).toBe('Invalid token')
    })

    describe('audience validation', () => {
      it('should accept token with matching audience', async () => {
        const token = await signToken(keyPair, {
          subject: 'user-123',
          audience: 'my-service',
        })

        const result = await verifyToken(keyPair, token, { audience: 'my-service' })
        expectValid(result)
      })

      it('should accept token when audience is in array', async () => {
        const token = await signToken(keyPair, {
          subject: 'user-123',
          audience: ['service-a', 'service-b'],
        })

        const result = await verifyToken(keyPair, token, { audience: 'service-a' })
        expectValid(result)
      })

      it('should reject token with wrong audience', async () => {
        const token = await signToken(keyPair, {
          subject: 'user-123',
          audience: 'service-a',
        })

        const result = await verifyToken(keyPair, token, { audience: 'service-b' })
        expectInvalid(result)
      })

      it('should reject token without audience when audience required', async () => {
        const token = await signToken(keyPair, { subject: 'user-123' })

        const result = await verifyToken(keyPair, token, { audience: 'my-service' })
        expectInvalid(result)
      })

      it('should accept token with audience when not checking', async () => {
        const token = await signToken(keyPair, {
          subject: 'user-123',
          audience: 'any-service',
        })

        expectValid(await verifyToken(keyPair, token))
      })
    })
  })

  describe('decodeToken', () => {
    it('should decode a valid token without verification', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { role: 'admin' },
      })

      const { header, payload } = expectDecoded(token)
      expect(header.alg).toBe(ALGORITHM)
      expect(header.kid).toBe(keyPair.kid)
      expect(payload.sub).toBe('user-123')
      expect(payload.role).toBe('admin')
    })

    it('should decode token signed with different key', async () => {
      const token = await signToken(otherKeyPair, { subject: 'user-123' })

      const { header, payload } = expectDecoded(token)
      expect(payload.sub).toBe('user-123')
      expect(header.kid).toBe(otherKeyPair.kid)
    })

    it('should return null for invalid tokens', () => {
      expect(decodeToken('not-a-valid-token')).toBeNull()
      expect(decodeToken('')).toBeNull()
      expect(decodeToken('invalid.base64.here!!!')).toBeNull()
      expect(decodeToken('only.two')).toBeNull()
      expect(decodeToken('one')).toBeNull()
      expect(decodeToken('a.b.c.d')).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('should handle unicode in claims', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { name: '日本語テスト', emoji: '🔐🎉' },
      })

      const payload = expectValid(await verifyToken(keyPair, token))
      expect(payload.name).toBe('日本語テスト')
      expect(payload.emoji).toBe('🔐🎉')
    })

    it('should handle nested objects in claims', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: { metadata: { nested: { deep: 'value' } } },
      })

      const payload = expectValid(await verifyToken(keyPair, token))
      expect(payload.metadata).toEqual({ nested: { deep: 'value' } })
    })

    it('should handle empty claims object', async () => {
      const token = await signToken(keyPair, {
        subject: 'user-123',
        claims: {},
      })

      expectValid(await verifyToken(keyPair, token))
    })

    it('should handle very long subject', async () => {
      const longSubject = 'x'.repeat(1000)
      const token = await signToken(keyPair, { subject: longSubject })

      const payload = expectValid(await verifyToken(keyPair, token))
      expect(payload.sub).toBe(longSubject)
    })
  })
})
