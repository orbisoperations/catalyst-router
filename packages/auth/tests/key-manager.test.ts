import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileSystemKeyManager } from '../src/key-manager';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_KEYS_DIR = join(__dirname, 'test-keys-manager');

describe('FileSystemKeyManager', () => {
    beforeEach(() => {
        try { rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch { }
        mkdirSync(TEST_KEYS_DIR, { recursive: true });
    });

    afterEach(() => {
        try { rmSync(TEST_KEYS_DIR, { recursive: true, force: true }); } catch { }
    });

    it('should init and generate key', async () => {
        const km = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km.init();

        const keys = await km.getPublicKeys();
        expect(keys.keys).toHaveLength(1);
    });

    it('should sign and verify', async () => {
        const km = new FileSystemKeyManager(TEST_KEYS_DIR);
        const token = await km.sign({ subject: 'test', expiresIn: '1h' });

        const res = await km.verify(token);
        expect(res.valid).toBe(true);
        if (res.valid) {
            expect(res.payload.sub).toBe('test');
        }
    });

    it('should rotate gracefully', async () => {
        const km = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km.init();
        const keys1 = await km.getPublicKeys();
        const kid1 = keys1.keys[0].kid;

        // Sign with old key
        const tokenOld = await km.sign({ subject: 'old', expiresIn: '1h' });

        // Rotate
        await km.rotate(false);
        const keys2 = await km.getPublicKeys();

        expect(keys2.keys).toHaveLength(2);

        // Verify old token still works
        const resOld = await km.verify(tokenOld);
        expect(resOld.valid).toBe(true);

        // Sign with new
        const tokenNew = await km.sign({ subject: 'new', expiresIn: '1h' });
        const resNew = await km.verify(tokenNew);
        expect(resNew.valid).toBe(true);
    });

    it('should rotate immediately', async () => {
        const km = new FileSystemKeyManager(TEST_KEYS_DIR);
        await km.init();

        // Sign with old key (note: sign() uses current key, so we need to sign before rotate)
        const tokenOld = await km.sign({ subject: 'old', expiresIn: '1h' });

        // Rotate immediate
        await km.rotate(true);

        const keys2 = await km.getPublicKeys();
        expect(keys2.keys).toHaveLength(1);

        // Verify old token fails (since key is gone from memory)
        // Note: In real world, if key is gone, signature verification fails.
        const resOld = await km.verify(tokenOld);
        expect(resOld.valid).toBe(false);
    });
});
