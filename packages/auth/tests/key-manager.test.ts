import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystemKeyManager } from '../src/key-manager.js';
import { rmSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const TEST_KEYS_DIR = join(__dirname, 'test-keys-manager-persistence');

describe('FileSystemKeyManager Persistence', () => {
    beforeEach(() => {
        try {
            rmSync(TEST_KEYS_DIR, { recursive: true, force: true });
        } catch {
            // Ignore error
        }
        mkdirSync(TEST_KEYS_DIR, { recursive: true });
    });

    afterEach(() => {
        try {
            rmSync(TEST_KEYS_DIR, { recursive: true, force: true });
        } catch {
            // Ignore error
        }
    });

    it('should persist current key', async () => {
        const km1 = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km1.init();
        const keys1 = await km1.getPublicKeys();
        const kid1 = keys1.keys[0].kid;

        // New instance, same dir
        const km2 = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km2.init();
        const keys2 = await km2.getPublicKeys();

        expect(keys2.keys[0].kid).toBe(kid1);
    });

    it('should persist archived keys after graceful rotation', async () => {
        const km1 = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km1.init();

        // Sign with key 1
        const token1 = await km1.sign({ subject: 'u1', expiresIn: '1h' });
        const keys1 = await km1.getPublicKeys();
        const kid1 = keys1.keys[0].kid;

        // Rotate
        await km1.rotate(false); // Graceful

        // Check filesystem
        const archiveDir = join(TEST_KEYS_DIR, 'archive');
        expect(existsSync(archiveDir)).toBe(true);
        const archives = readdirSync(archiveDir);
        expect(archives.length).toBe(1);

        // New instance (simulate restart)
        const km2 = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km2.init();

        // Should have 2 keys loaded
        const keys2 = await km2.getPublicKeys();
        expect(keys2.keys).toHaveLength(2);

        const kids = keys2.keys.map(k => k.kid);
        expect(kids).toContain(kid1);

        // Should verify old token
        const res = await km2.verify(token1);
        expect(res.valid).toBe(true);
    });

    it('should clean up expired archived keys (mocked via low grace period)', async () => {
        // We can't easily wait 24h, but we can call loadArchivedKeys? 
        // Or we can manually create an expired archive file to test cleanup logic.

        const archiveDir = join(TEST_KEYS_DIR, 'archive');
        mkdirSync(archiveDir, { recursive: true });

        // Create a dummy expired key file
        const expiredTime = Date.now() - 10000;
        const fs = await import('fs');
        fs.writeFileSync(join(archiveDir, `keypair.${expiredTime}.json`), '{}');

        const km = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km.init(); // Should trigger loadArchivedKeys and cleanup

        const archives = readdirSync(archiveDir);
        expect(archives.length).toBe(0); // Should be gone
    });
});
