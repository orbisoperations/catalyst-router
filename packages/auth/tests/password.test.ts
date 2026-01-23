import { describe, it, expect } from 'bun:test'
import { hashPassword, verifyPassword, timingSafeEqual } from '../src/password.js'

describe('Password utilities', () => {
  describe('hashPassword', () => {
    it('should hash a password with Argon2id', async () => {
      const hash = await hashPassword('mySecurePassword123')

      expect(hash).toMatch(/^\$argon2id\$/)
      expect(hash.length).toBeGreaterThan(50)
    })

    it('should produce different hashes for same password (salt)', async () => {
      const hash1 = await hashPassword('samePassword')
      const hash2 = await hashPassword('samePassword')

      expect(hash1).not.toBe(hash2)
    })
  })

  describe('verifyPassword', () => {
    it('should verify correct password', async () => {
      const password = 'correctPassword123'
      const hash = await hashPassword(password)

      const result = await verifyPassword(hash, password)
      expect(result).toBe(true)
    })

    it('should reject incorrect password', async () => {
      const hash = await hashPassword('correctPassword')

      const result = await verifyPassword(hash, 'wrongPassword')
      expect(result).toBe(false)
    })

    it('should handle empty password', async () => {
      const hash = await hashPassword('realPassword')

      const result = await verifyPassword(hash, '')
      expect(result).toBe(false)
    })
  })

  describe('timingSafeEqual', () => {
    it('should return true for equal strings', () => {
      expect(timingSafeEqual('hello', 'hello')).toBe(true)
      expect(timingSafeEqual('', '')).toBe(true)
    })

    it('should return false for different strings', () => {
      expect(timingSafeEqual('hello', 'world')).toBe(false)
      expect(timingSafeEqual('hello', 'hello!')).toBe(false)
    })

    it('should return false for different lengths', () => {
      expect(timingSafeEqual('short', 'longer string')).toBe(false)
    })
  })
})
