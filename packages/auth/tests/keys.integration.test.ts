import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as jose from 'jose';
import {
    generateKeyPair,
    saveKeyPair,
    loadKeyPair,
    loadOrGenerateKeyPair,
    getJwks,
    type SerializedKeyPair
} from '../src/keys.js';

describe('Keys Integration Tests - File Persistence', () => {
    let testKeysDir: string;

    beforeEach(() => {
        // Create unique temp directory for each test
        testKeysDir = join(tmpdir(), `catalyst-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testKeysDir, { recursive: true });
    });

    afterEach(() => {
        // Clean up temp directory
        if (existsSync(testKeysDir)) {
            rmSync(testKeysDir, { recursive: true, force: true });
        }
    });

    describe('saveKeyPair', () => {
        it('should save keypair to specified directory', async () => {
            const keyPair = await generateKeyPair();
            await saveKeyPair(keyPair, testKeysDir);

            const filePath = join(testKeysDir, 'keypair.json');
            expect(existsSync(filePath)).toBe(true);
        });

        it('should create directory if it does not exist', async () => {
            const nestedDir = join(testKeysDir, 'nested', 'dir');
            const keyPair = await generateKeyPair();

            await saveKeyPair(keyPair, nestedDir);

            expect(existsSync(nestedDir)).toBe(true);
            expect(existsSync(join(nestedDir, 'keypair.json'))).toBe(true);
        });

        it('should save keypair in valid JSON format', async () => {
            const keyPair = await generateKeyPair();
            await saveKeyPair(keyPair, testKeysDir);

            const filePath = join(testKeysDir, 'keypair.json');
            const data = readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(data) as SerializedKeyPair;

            expect(parsed.privateKeyJwk).toBeDefined();
            expect(parsed.publicKeyJwk).toBeDefined();
            expect(parsed.kid).toBe(keyPair.kid);
            expect(parsed.createdAt).toBeDefined();
        });

        it('should preserve all key properties in saved file', async () => {
            const keyPair = await generateKeyPair();
            await saveKeyPair(keyPair, testKeysDir);

            const filePath = join(testKeysDir, 'keypair.json');
            const data = readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(data) as SerializedKeyPair;

            // Verify algorithm and use are preserved
            expect(parsed.privateKeyJwk.alg).toBe('ES384');
            expect(parsed.privateKeyJwk.use).toBe('sig');
            expect(parsed.publicKeyJwk.alg).toBe('ES384');
            expect(parsed.publicKeyJwk.use).toBe('sig');

            // Verify EC curve parameters
            expect(parsed.publicKeyJwk.kty).toBe('EC');
            expect(parsed.publicKeyJwk.crv).toBe('P-384');
        });

        it('should overwrite existing keypair file', async () => {
            const keyPair1 = await generateKeyPair();
            await saveKeyPair(keyPair1, testKeysDir);

            const keyPair2 = await generateKeyPair();
            await saveKeyPair(keyPair2, testKeysDir);

            const filePath = join(testKeysDir, 'keypair.json');
            const data = readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(data) as SerializedKeyPair;

            expect(parsed.kid).toBe(keyPair2.kid);
            expect(parsed.kid).not.toBe(keyPair1.kid);
        });
    });

    describe('loadKeyPair', () => {
        it('should load previously saved keypair', async () => {
            const original = await generateKeyPair();
            await saveKeyPair(original, testKeysDir);

            const loaded = await loadKeyPair(testKeysDir);

            expect(loaded).not.toBeNull();
            expect(loaded!.kid).toBe(original.kid);
        });

        it('should return null if no keypair file exists', async () => {
            const loaded = await loadKeyPair(testKeysDir);

            expect(loaded).toBeNull();
        });

        it('should return null for non-existent directory', async () => {
            const nonExistentDir = join(testKeysDir, 'does-not-exist');

            const loaded = await loadKeyPair(nonExistentDir);

            expect(loaded).toBeNull();
        });

        it('should load keys that can sign and verify', async () => {
            const original = await generateKeyPair();
            await saveKeyPair(original, testKeysDir);

            const loaded = await loadKeyPair(testKeysDir);
            expect(loaded).not.toBeNull();

            // Sign with loaded private key
            const jwt = await new jose.SignJWT({ test: 'loaded-key' })
                .setProtectedHeader({ alg: 'ES384', kid: loaded!.kid })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(loaded!.privateKey);

            // Verify with loaded public key
            const { payload } = await jose.jwtVerify(jwt, loaded!.publicKey);
            expect(payload.test).toBe('loaded-key');
        });

        it('should load keys compatible with original keys', async () => {
            const original = await generateKeyPair();

            // Sign with original key before saving
            const jwt = await new jose.SignJWT({ test: 'before-save' })
                .setProtectedHeader({ alg: 'ES384', kid: original.kid })
                .sign(original.privateKey);

            await saveKeyPair(original, testKeysDir);
            const loaded = await loadKeyPair(testKeysDir);

            // Verify the JWT signed before save with the loaded key
            const { payload } = await jose.jwtVerify(jwt, loaded!.publicKey);
            expect(payload.test).toBe('before-save');
        });
    });

    describe('loadOrGenerateKeyPair', () => {
        it('should generate new keypair when none exists', async () => {
            const result = await loadOrGenerateKeyPair(testKeysDir);

            expect(result).toBeDefined();
            expect(result.keyPair.kid).toBeDefined();
            expect(result.keyPair.privateKey).toBeDefined();
            expect(result.keyPair.publicKey).toBeDefined();
            expect(result.generated).toBe(true);
        });

        it('should save generated keypair to disk', async () => {
            await loadOrGenerateKeyPair(testKeysDir);

            const filePath = join(testKeysDir, 'keypair.json');
            expect(existsSync(filePath)).toBe(true);
        });

        it('should load existing keypair when present', async () => {
            // Generate and save a keypair first
            const original = await generateKeyPair();
            await saveKeyPair(original, testKeysDir);

            // Now call loadOrGenerateKeyPair
            const result = await loadOrGenerateKeyPair(testKeysDir);

            expect(result.keyPair.kid).toBe(original.kid);
            expect(result.generated).toBe(false);
        });

        it('should not overwrite existing keypair', async () => {
            const original = await generateKeyPair();
            await saveKeyPair(original, testKeysDir);

            // Call loadOrGenerateKeyPair multiple times
            const result1 = await loadOrGenerateKeyPair(testKeysDir);
            const result2 = await loadOrGenerateKeyPair(testKeysDir);

            expect(result1.keyPair.kid).toBe(original.kid);
            expect(result2.keyPair.kid).toBe(original.kid);
        });

        it('should create directory if it does not exist', async () => {
            const nestedDir = join(testKeysDir, 'nested', 'auth', 'keys');

            await loadOrGenerateKeyPair(nestedDir);

            expect(existsSync(nestedDir)).toBe(true);
            expect(existsSync(join(nestedDir, 'keypair.json'))).toBe(true);
        });
    });

    describe('End-to-End Key Lifecycle', () => {
        it('should support complete key lifecycle: generate -> save -> load -> use', async () => {
            // 1. Generate a new keypair
            const keyPair = await generateKeyPair();
            // JWK thumbprint is base64url-encoded SHA-256 hash (43 chars)
            expect(keyPair.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);

            // 2. Save to disk
            await saveKeyPair(keyPair, testKeysDir);

            // 3. Load from disk
            const loaded = await loadKeyPair(testKeysDir);
            expect(loaded).not.toBeNull();

            // 4. Use for JWT operations
            const claims = { sub: 'user123', role: 'admin' };
            const jwt = await new jose.SignJWT(claims)
                .setProtectedHeader({ alg: 'ES384', kid: loaded!.kid })
                .setIssuedAt()
                .setExpirationTime('1h')
                .setIssuer('catalyst-auth')
                .sign(loaded!.privateKey);

            // 5. Verify with JWKS
            const jwks = await getJwks(loaded!);
            const keySet = jose.createLocalJWKSet(jwks);
            const { payload } = await jose.jwtVerify(jwt, keySet);

            expect(payload.sub).toBe('user123');
            expect(payload.role).toBe('admin');
            expect(payload.iss).toBe('catalyst-auth');
        });

        it('should maintain key continuity across save/load cycles', async () => {
            const keyPair = await generateKeyPair();

            // Sign multiple JWTs
            const jwt1 = await new jose.SignJWT({ id: 1 })
                .setProtectedHeader({ alg: 'ES384', kid: keyPair.kid })
                .sign(keyPair.privateKey);

            const jwt2 = await new jose.SignJWT({ id: 2 })
                .setProtectedHeader({ alg: 'ES384', kid: keyPair.kid })
                .sign(keyPair.privateKey);

            // Save and reload
            await saveKeyPair(keyPair, testKeysDir);
            const loaded = await loadKeyPair(testKeysDir);

            // Verify both JWTs with reloaded key
            const { payload: p1 } = await jose.jwtVerify(jwt1, loaded!.publicKey);
            const { payload: p2 } = await jose.jwtVerify(jwt2, loaded!.publicKey);

            expect(p1.id).toBe(1);
            expect(p2.id).toBe(2);
        });

        it('should export JWKS suitable for public distribution', async () => {
            const result = await loadOrGenerateKeyPair(testKeysDir);
            const jwks = await getJwks(result.keyPair);

            // JWKS should be safe for public distribution
            for (const key of jwks.keys) {
                // Should NOT contain private key material
                expect(key.d).toBeUndefined();

                // Should contain required public key fields
                expect(key.kty).toBe('EC');
                expect(key.crv).toBe('P-384');
                expect(key.x).toBeDefined();
                expect(key.y).toBeDefined();
                expect(key.kid).toBeDefined();
                expect(key.alg).toBe('ES384');
                expect(key.use).toBe('sig');
            }
        });
    });

    describe('Error Handling', () => {
        it('should handle corrupted keypair file gracefully', async () => {
            const filePath = join(testKeysDir, 'keypair.json');
            const { writeFileSync } = await import('fs');
            writeFileSync(filePath, 'not valid json', 'utf-8');

            await expect(loadKeyPair(testKeysDir)).rejects.toThrow();
        });

        it('should handle invalid JWK data in keypair file', async () => {
            const filePath = join(testKeysDir, 'keypair.json');
            const { writeFileSync } = await import('fs');

            const invalidData: SerializedKeyPair = {
                privateKeyJwk: { kty: 'invalid' } as unknown as { kty: string },
                publicKeyJwk: { kty: 'invalid' } as unknown as { kty: string },
                kid: 'test-kid',
                createdAt: new Date().toISOString()
            };

            writeFileSync(filePath, JSON.stringify(invalidData), 'utf-8');

            await expect(loadKeyPair(testKeysDir)).rejects.toThrow();
        });
    });

    describe('Concurrent Access', () => {
        it('should handle concurrent loadOrGenerateKeyPair calls', async () => {
            // Simulate concurrent calls
            const results = await Promise.all([
                loadOrGenerateKeyPair(testKeysDir),
                loadOrGenerateKeyPair(testKeysDir),
                loadOrGenerateKeyPair(testKeysDir)
            ]);

            // All should succeed
            expect(results).toHaveLength(3);
            results.forEach(result => {
                expect(result.keyPair.kid).toBeDefined();
                expect(result.keyPair.privateKey).toBeDefined();
                expect(result.keyPair.publicKey).toBeDefined();
            });
        });

        it('should handle concurrent saveKeyPair calls', async () => {
            const keyPairs = await Promise.all([
                generateKeyPair(),
                generateKeyPair(),
                generateKeyPair()
            ]);

            // Save concurrently (last one wins)
            await Promise.all(
                keyPairs.map(kp => saveKeyPair(kp, testKeysDir))
            );

            // File should exist and be valid
            const loaded = await loadKeyPair(testKeysDir);
            expect(loaded).not.toBeNull();

            // Should be one of the saved keypairs
            const kids = keyPairs.map(kp => kp.kid);
            expect(kids).toContain(loaded!.kid);
        });
    });
});
