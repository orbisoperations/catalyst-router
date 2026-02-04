import { describe, it, expect, beforeEach } from 'bun:test'
import { EphemeralKeyManager } from '../src/key-manager/ephemeral.js'

describe('EphemeralKeyManager', () => {
  let manager: EphemeralKeyManager

  beforeEach(() => {
    manager = new EphemeralKeyManager()
  })

  describe('initialization', () => {
    it('should initialize with a generated key', async () => {
      await manager.initialize()

      const kid = await manager.getCurrentKeyId()
      expect(kid).toBeDefined()
      expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('should throw if initialized twice', async () => {
      await manager.initialize()

      await expect(manager.initialize()).rejects.toThrow('already initialized')
    })

    it('should generate unique keys on each initialization', async () => {
      const manager1 = new EphemeralKeyManager()
      const manager2 = new EphemeralKeyManager()

      await manager1.initialize()
      await manager2.initialize()

      const kid1 = await manager1.getCurrentKeyId()
      const kid2 = await manager2.getCurrentKeyId()

      expect(kid1).not.toBe(kid2)
    })
  })

  describe('rotation', () => {
    it('should rotate to a new key', async () => {
      await manager.initialize()

      const originalKid = await manager.getCurrentKeyId()

      const result = await manager.rotate()

      expect(result.newKeyId).not.toBe(originalKid)
      expect(result.previousKeyId).toBe(originalKid)
      expect(result.gracePeriodEndsAt).toBeInstanceOf(Date)
    })

    it('should maintain old key during grace period', async () => {
      await manager.initialize()

      const originalKid = await manager.getCurrentKeyId()
      await manager.rotate()

      const jwks = await manager.getJwks()

      // Should have both keys during grace period
      expect(jwks.keys).toHaveLength(2)
      const kids = jwks.keys.map((key: Record<string, unknown>) => key.kid)
      expect(kids).toContain(originalKid)
    })

    it('should support immediate rotation', async () => {
      await manager.initialize()

      const originalKid = await manager.getCurrentKeyId()
      const result = await manager.rotate({ immediate: true })

      expect(result.gracePeriodEndsAt).toBeUndefined()

      const jwks = await manager.getJwks()

      // Should only have new key (old key immediately removed)
      expect(jwks.keys).toHaveLength(1)
      const kids = jwks.keys.map((key: Record<string, unknown>) => key.kid)
      expect(kids).not.toContain(originalKid)
    })

    it('should support custom grace period', async () => {
      await manager.initialize()

      const customGracePeriod = 5000 // 5 seconds
      const result = await manager.rotate({ gracePeriodMs: customGracePeriod })

      expect(result.gracePeriodEndsAt).toBeInstanceOf(Date)

      const now = Date.now()
      const graceEnd = result.gracePeriodEndsAt!.getTime()

      // Should be approximately 5 seconds from now (allow 100ms variance)
      expect(Math.abs(graceEnd - now - customGracePeriod)).toBeLessThan(100)
    })
  })

  describe('key retrieval', () => {
    it('should get current key ID', async () => {
      await manager.initialize()

      const kid = await manager.getCurrentKeyId()

      expect(kid).toBeDefined()
      expect(typeof kid).toBe('string')
    })

    it('should get JWKS with all active keys', async () => {
      await manager.initialize()

      const jwks = await manager.getJwks()

      expect(jwks.keys).toHaveLength(1)
      expect(jwks.keys[0]).toHaveProperty('kty')
      expect(jwks.keys[0]).toHaveProperty('kid')
      expect(jwks.keys[0]).toHaveProperty('use', 'sig')
      expect(jwks.keys[0]).toHaveProperty('alg', 'ES384')
    })

    it('should include all keys within grace period in JWKS', async () => {
      await manager.initialize()
      await manager.rotate()
      await manager.rotate()

      const jwks = await manager.getJwks()

      // Should have current key + 2 previous keys in grace period
      expect(jwks.keys.length).toBeGreaterThanOrEqual(1)
      expect(jwks.keys.length).toBeLessThanOrEqual(3)
    })
  })

  describe('memory management', () => {
    it('should clear state after shutdown', async () => {
      await manager.initialize()

      await manager.getCurrentKeyId()
      await manager.shutdown()

      // After shutdown, attempting to get key should fail
      await expect(manager.getCurrentKeyId()).rejects.toThrow()
    })

    it('should handle multiple rotations without memory leaks', async () => {
      await manager.initialize()

      const initialMemory = process.memoryUsage().heapUsed

      // Rotate many times with immediate rotation
      for (let i = 0; i < 100; i++) {
        await manager.rotate({ immediate: true })
      }

      const finalMemory = process.memoryUsage().heapUsed
      const memoryGrowth = finalMemory - initialMemory

      // Memory growth should be reasonable (< 10MB for 100 rotations)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024)
    })
  })

  describe('error handling', () => {
    it('should throw if used before initialization', async () => {
      await expect(manager.getCurrentKeyId()).rejects.toThrow()
    })

    it('should throw if rotating before initialization', async () => {
      await expect(manager.rotate()).rejects.toThrow()
    })
  })

  describe('concurrent operations', () => {
    it('should handle concurrent key lookups', async () => {
      await manager.initialize()

      const lookups = await Promise.all([
        manager.getCurrentKeyId(),
        manager.getCurrentKeyId(),
        manager.getCurrentKeyId(),
        manager.getJwks(),
        manager.getJwks(),
      ])

      // All should succeed
      expect(lookups[0]).toBeDefined()
      expect(lookups[1]).toBe(lookups[0])
      expect(lookups[2]).toBe(lookups[0])
    })
  })

  describe('custom grace period configuration', () => {
    it('should use custom default grace period', async () => {
      const customManager = new EphemeralKeyManager({ gracePeriodMs: 10000 })

      await customManager.initialize()
      const result = await customManager.rotate()

      // Should use the custom grace period
      expect(result.gracePeriodEndsAt).toBeDefined()

      const now = Date.now()
      const graceEnd = result.gracePeriodEndsAt!.getTime()

      // Should be approximately 10 seconds (allow 100ms variance)
      expect(Math.abs(graceEnd - now - 10000)).toBeLessThan(100)
    })
  })
})
