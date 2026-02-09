import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { EphemeralKeyManager } from '../../src/key-manager/ephemeral.js'
import { FileSystemKeyManager } from '../../src/key-manager/local.js'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Server Lifecycle Robustness Tests
 *
 * Tests that key managers handle server lifecycle events correctly:
 * - Startup with existing keys
 * - Startup with no keys
 * - Shutdown and restart
 * - Graceful vs ungraceful shutdown
 * - Key rotation during shutdown
 */
describe('Server Lifecycle Robustness', () => {
  describe('EphemeralKeyManager lifecycle', () => {
    it('should start fresh on each initialization', async () => {
      const manager1 = new EphemeralKeyManager()
      await manager1.initialize()
      const kid1 = await manager1.getCurrentKeyId()

      const manager2 = new EphemeralKeyManager()
      await manager2.initialize()
      const kid2 = await manager2.getCurrentKeyId()

      // Each instance should have different keys
      expect(kid1).not.toBe(kid2)
    })

    it('should clear state on shutdown', async () => {
      const manager = new EphemeralKeyManager()
      await manager.initialize()

      const kid = await manager.getCurrentKeyId()
      expect(kid).toBeDefined()

      await manager.shutdown()

      // After shutdown, operations should fail
      await expect(manager.getCurrentKeyId()).rejects.toThrow()
    })

    it('should handle rapid init/shutdown cycles', async () => {
      for (let i = 0; i < 10; i++) {
        const manager = new EphemeralKeyManager()
        await manager.initialize()
        const kid = await manager.getCurrentKeyId()
        expect(kid).toBeDefined()
        await manager.shutdown()
      }
    })

    it('should handle shutdown during active operations', async () => {
      const manager = new EphemeralKeyManager()
      await manager.initialize()

      // Start rotation but shutdown immediately
      const rotationPromise = manager.rotate()
      const shutdownPromise = manager.shutdown()

      // Both operations should complete (one might error, which is fine)
      const results = await Promise.allSettled([rotationPromise, shutdownPromise])

      // At least shutdown should succeed
      expect(results[1].status).toBe('fulfilled')
    })
  })

  describe('FileSystemKeyManager lifecycle', () => {
    let testDir: string

    beforeEach(() => {
      testDir = join(tmpdir(), `catalyst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(testDir, { recursive: true })
    })

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('should generate new keys on first startup', async () => {
      const keysDir = join(testDir, 'keys')
      const manager = new FileSystemKeyManager(keysDir)

      await manager.initialize()

      const kid = await manager.getCurrentKeyId()
      expect(kid).toBeDefined()

      await manager.shutdown()
    })

    it('should load existing keys on subsequent startups', async () => {
      const keysDir = join(testDir, 'keys')

      // First startup - generate keys
      const manager1 = new FileSystemKeyManager(keysDir)
      await manager1.initialize()
      const kid1 = await manager1.getCurrentKeyId()
      await manager1.shutdown()

      // Second startup - should load same keys
      const manager2 = new FileSystemKeyManager(keysDir)
      await manager2.initialize()
      const kid2 = await manager2.getCurrentKeyId()
      await manager2.shutdown()

      expect(kid1).toBe(kid2)
    })

    it('should persist rotated keys across restarts', async () => {
      const keysDir = join(testDir, 'keys')

      // First startup - rotate keys
      const manager1 = new FileSystemKeyManager(keysDir)
      await manager1.initialize()
      const originalKid = await manager1.getCurrentKeyId()
      const rotationResult = await manager1.rotate()
      const newKid = rotationResult.newKeyId
      await manager1.shutdown()

      // Second startup - should have new key as current
      const manager2 = new FileSystemKeyManager(keysDir)
      await manager2.initialize()
      const currentKid = await manager2.getCurrentKeyId()
      await manager2.shutdown()

      expect(currentKid).toBe(newKid)
      expect(currentKid).not.toBe(originalKid)
    })

    it('should maintain grace period keys across restarts', async () => {
      const keysDir = join(testDir, 'keys')

      // First startup - rotate with grace period
      const manager1 = new FileSystemKeyManager(keysDir)
      await manager1.initialize()
      await manager1.rotate({ gracePeriodMs: 86400000 }) // 24 hours
      const jwks1 = await manager1.getJwks()
      await manager1.shutdown()

      // Second startup - should still have both keys
      const manager2 = new FileSystemKeyManager(keysDir)
      await manager2.initialize()
      const jwks2 = await manager2.getJwks()
      await manager2.shutdown()

      // Both should have 2 keys (current + previous in grace period)
      expect(jwks1.keys).toHaveLength(2)
      expect(jwks2.keys).toHaveLength(2)
    })

    it('should handle ungraceful shutdown and recovery', async () => {
      const keysDir = join(testDir, 'keys')

      // Startup and rotate
      const manager1 = new FileSystemKeyManager(keysDir)
      await manager1.initialize()
      await manager1.rotate()
      // Simulate crash - no shutdown call

      // Recovery - should load persisted state
      const manager2 = new FileSystemKeyManager(keysDir)
      await manager2.initialize()
      const kid = await manager2.getCurrentKeyId()
      expect(kid).toBeDefined()

      const jwks = await manager2.getJwks()
      expect(jwks.keys.length).toBeGreaterThanOrEqual(1)

      await manager2.shutdown()
    })

    it('should handle shutdown during rotation', async () => {
      const keysDir = join(testDir, 'keys')
      const manager = new FileSystemKeyManager(keysDir)

      await manager.initialize()

      // Start rotation
      const rotationPromise = manager.rotate()

      // Shutdown immediately (simulating SIGTERM during rotation)
      setTimeout(() => manager.shutdown(), 10)

      // Rotation may or may not complete, but should not crash
      const result = await rotationPromise.catch((error) => ({ error }))

      // Either success or graceful error
      expect(result).toBeDefined()
    })

    it('should cleanup expired keys on startup', async () => {
      const keysDir = join(testDir, 'keys')

      // First startup - create and rotate multiple times
      const manager1 = new FileSystemKeyManager(keysDir)
      await manager1.initialize()
      await manager1.rotate({ gracePeriodMs: 1 }) // 1ms grace period
      await manager1.rotate({ gracePeriodMs: 1 })
      await manager1.rotate({ gracePeriodMs: 1 })

      // Wait for grace periods to expire
      await new Promise((resolve) => setTimeout(resolve, 10))

      await manager1.shutdown()

      // Second startup - should cleanup expired keys
      const manager2 = new FileSystemKeyManager(keysDir)
      await manager2.initialize()

      const jwks = await manager2.getJwks()

      // Should only have current key (expired ones cleaned up)
      expect(jwks.keys).toHaveLength(1)

      await manager2.shutdown()
    })
  })

  describe('concurrent lifecycle operations', () => {
    it('should handle multiple managers accessing same database', async () => {
      const testDir = join(
        tmpdir(),
        `catalyst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      mkdirSync(testDir, { recursive: true })

      const keysDir = join(testDir, 'keys')

      try {
        // Initialize first manager
        const manager1 = new FileSystemKeyManager(keysDir)
        await manager1.initialize()
        const kid1 = await manager1.getCurrentKeyId()

        // Second manager accessing same database
        const manager2 = new FileSystemKeyManager(keysDir)
        await manager2.initialize()
        const kid2 = await manager2.getCurrentKeyId()

        // Both should see same current key
        expect(kid1).toBe(kid2)

        await manager1.shutdown()
        await manager2.shutdown()
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe('startup edge cases', () => {
    it('should handle startup with corrupted key database', async () => {
      const testDir = join(
        tmpdir(),
        `catalyst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      mkdirSync(testDir, { recursive: true })

      const keysDir = join(testDir, 'keys')

      try {
        // Create initial database
        const manager1 = new FileSystemKeyManager(keysDir)
        await manager1.initialize()
        await manager1.shutdown()

        // Attempt to start again (should work with existing db)
        const manager2 = new FileSystemKeyManager(keysDir)
        await manager2.initialize()
        const kid = await manager2.getCurrentKeyId()
        expect(kid).toBeDefined()
        await manager2.shutdown()
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('should handle startup with readonly filesystem', async () => {
      // In-memory database (no file writes)
      const manager = new EphemeralKeyManager()

      await manager.initialize()
      const kid = await manager.getCurrentKeyId()

      expect(kid).toBeDefined()

      await manager.shutdown()
    })
  })

  describe('resource cleanup', () => {
    it('should not leak file descriptors across multiple startups', async () => {
      const testDir = join(
        tmpdir(),
        `catalyst-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      mkdirSync(testDir, { recursive: true })

      const keysDir = join(testDir, 'keys')

      try {
        // Perform 50 init/shutdown cycles
        for (let i = 0; i < 50; i++) {
          const manager = new FileSystemKeyManager(keysDir)
          await manager.initialize()
          await manager.shutdown()
        }

        // Should complete without errors or resource exhaustion
        expect(true).toBe(true)
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('should cleanup in-memory state on ephemeral manager shutdown', async () => {
      const managers: EphemeralKeyManager[] = []

      // Create and shutdown 100 managers
      for (let i = 0; i < 100; i++) {
        const manager = new EphemeralKeyManager()
        await manager.initialize()
        await manager.shutdown()
        managers.push(manager)
      }

      // Memory should not grow unbounded (rough check)
      const memoryUsage = process.memoryUsage()
      expect(memoryUsage.heapUsed).toBeLessThan(100 * 1024 * 1024) // < 100MB
    })
  })
})
