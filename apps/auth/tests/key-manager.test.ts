import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { FileSystemKeyManager } from '../src/key-manager/local.js'
import { rmSync, mkdirSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const TEST_KEYS_DIR = join(__dirname, 'test-keys-manager-persistence')

describe('FileSystemKeyManager Persistence', () => {
  beforeEach(() => {
    try {
      rmSync(TEST_KEYS_DIR, { recursive: true, force: true })
    } catch {
      /* ignore cleanup errors */
    }
    mkdirSync(TEST_KEYS_DIR, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TEST_KEYS_DIR, { recursive: true, force: true })
    } catch {
      /* ignore cleanup errors */
    }
  })

  it('should persist current key', async () => {
    const km1 = new FileSystemKeyManager(TEST_KEYS_DIR)
    await km1.initialize()
    const keys1 = await km1.getJwks()
    const kid1 = keys1.keys[0].kid
    await km1.shutdown()

    // New instance, same dir
    const km2 = new FileSystemKeyManager(TEST_KEYS_DIR)
    await km2.initialize()
    const keys2 = await km2.getJwks()

    expect(keys2.keys[0].kid).toBe(kid1)
    await km2.shutdown()
  })

  it('should persist archived keys after graceful rotation', async () => {
    const km1 = new FileSystemKeyManager(TEST_KEYS_DIR)
    await km1.initialize()

    // Sign with key 1
    const token1 = await km1.sign({ subject: 'u1', expiresIn: '1h' })
    const keys1 = await km1.getJwks()
    const kid1 = keys1.keys[0].kid

    // Rotate (graceful)
    await km1.rotate({ immediate: false })
    await km1.shutdown()

    // Check filesystem
    const archiveDir = join(TEST_KEYS_DIR, 'archive')
    expect(existsSync(archiveDir)).toBe(true)
    const archives = readdirSync(archiveDir)
    expect(archives.length).toBe(1)

    // New instance (simulate restart)
    const km2 = new FileSystemKeyManager(TEST_KEYS_DIR)
    await km2.initialize()

    // Should have 2 keys loaded
    const keys2 = await km2.getJwks()
    expect(keys2.keys).toHaveLength(2)

    const kids = keys2.keys.map((k) => k.kid)
    expect(kids).toContain(kid1)

    // Should verify old token
    const res = await km2.verify(token1)
    expect(res.valid).toBe(true)
    await km2.shutdown()
  })

  it('should clean up expired archived keys on load', async () => {
    const archiveDir = join(TEST_KEYS_DIR, 'archive')
    mkdirSync(archiveDir, { recursive: true })

    // Create a dummy expired key file
    const expiredTime = Date.now() - 10000
    writeFileSync(join(archiveDir, `keypair.${expiredTime}.json`), '{}')

    const km = new FileSystemKeyManager(TEST_KEYS_DIR)
    await km.initialize()

    const archives = readdirSync(archiveDir)
    expect(archives.length).toBe(0) // Should be gone
    await km.shutdown()
  })
})
