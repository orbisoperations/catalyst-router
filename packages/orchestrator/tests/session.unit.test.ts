import { describe, it, expect } from 'bun:test'
import { Session } from '../src/auth/session.js'

describe('Session', () => {
  describe('construction', () => {
    it('should create session with auth context', () => {
      const session = new Session({
        auth: { userId: 'user-123', roles: ['admin'] },
      })
      expect(session.auth.userId).toBe('user-123')
      expect(session.auth.roles).toEqual(['admin'])
    })

    it('should generate unique connectionId', () => {
      const session1 = new Session({ auth: { userId: 'user-1' } })
      const session2 = new Session({ auth: { userId: 'user-2' } })
      expect(session1.connectionId).not.toBe(session2.connectionId)
    })

    it('should set connectedAt to current time', () => {
      const before = new Date()
      const session = new Session({ auth: { userId: 'user-123' } })
      const after = new Date()

      expect(session.connectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(session.connectedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('should set expiresAt when provided', () => {
      const expiry = new Date(Date.now() + 3600000) // 1 hour from now
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: expiry,
      })
      expect(session.expiresAt).toEqual(expiry)
    })

    it('should set expiresAt to null when not provided', () => {
      const session = new Session({ auth: { userId: 'user-123' } })
      expect(session.expiresAt).toBeNull()
    })
  })

  describe('isExpired', () => {
    it('should return false when no expiry is set', () => {
      const session = new Session({ auth: { userId: 'user-123' } })
      expect(session.isExpired()).toBe(false)
    })

    it('should return false when expiry is in the future', () => {
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      })
      expect(session.isExpired()).toBe(false)
    })

    it('should return true when expiry is in the past', () => {
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: new Date(Date.now() - 1000), // 1 second ago
      })
      expect(session.isExpired()).toBe(true)
    })

    it('should return true when expiry is exactly now', () => {
      const now = new Date()
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: now,
      })
      // Session expires at exactly now, so it should be considered expired
      expect(session.isExpired()).toBe(true)
    })
  })

  describe('remainingMs', () => {
    it('should return null when no expiry is set', () => {
      const session = new Session({ auth: { userId: 'user-123' } })
      expect(session.remainingMs()).toBeNull()
    })

    it('should return positive value when expiry is in future', () => {
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: new Date(Date.now() + 60000), // 1 minute from now
      })
      const remaining = session.remainingMs()
      expect(remaining).not.toBeNull()
      expect(remaining!).toBeGreaterThan(0)
      expect(remaining!).toBeLessThanOrEqual(60000)
    })

    it('should return 0 when expiry is in the past', () => {
      const session = new Session({
        auth: { userId: 'user-123' },
        expiresAt: new Date(Date.now() - 1000), // 1 second ago
      })
      expect(session.remainingMs()).toBe(0)
    })
  })
})
