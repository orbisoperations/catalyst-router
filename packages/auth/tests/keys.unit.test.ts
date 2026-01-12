import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as jose from 'jose';
import {
    generateKeyPair,
    exportKeyPair,
    importKeyPair,
    saveKeyPair,
    loadKeyPair,
    loadOrGenerateKeyPair,
    getPublicKeyJwk,
    getJwks,
    type KeyPair,
    type SerializedKeyPair
} from '../src/keys.js';

describe('Keys Unit Tests', () => {
    describe('generateKeyPair', () => {
        it('should generate a valid ES384 keypair', async () => {
            const keyPair = await generateKeyPair();

            expect(keyPair).toBeDefined();
            expect(keyPair.privateKey).toBeDefined();
            expect(keyPair.publicKey).toBeDefined();
            expect(keyPair.kid).toBeDefined();
        });

        it('should generate a key ID using JWK thumbprint', async () => {
            const keyPair = await generateKeyPair();

            // JWK thumbprint is base64url-encoded SHA-256 hash (43 chars)
            expect(keyPair.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
        });

        it('should generate unique key IDs for each keypair', async () => {
            const keyPair1 = await generateKeyPair();
            const keyPair2 = await generateKeyPair();

            expect(keyPair1.kid).not.toBe(keyPair2.kid);
        });

        it('should generate keys that can sign and verify', async () => {
            const keyPair = await generateKeyPair();

            // Create a JWT
            const jwt = await new jose.SignJWT({ test: 'data' })
                .setProtectedHeader({ alg: 'ES384', kid: keyPair.kid })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(keyPair.privateKey);

            // Verify the JWT
            const { payload } = await jose.jwtVerify(jwt, keyPair.publicKey);
            expect(payload.test).toBe('data');
        });
    });

    describe('exportKeyPair', () => {
        it('should export keypair to JWK format', async () => {
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);

            expect(serialized.privateKeyJwk).toBeDefined();
            expect(serialized.publicKeyJwk).toBeDefined();
            expect(serialized.kid).toBe(keyPair.kid);
            expect(serialized.createdAt).toBeDefined();
        });

        it('should include algorithm and use in exported JWKs', async () => {
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);

            expect(serialized.privateKeyJwk.alg).toBe('ES384');
            expect(serialized.privateKeyJwk.use).toBe('sig');
            expect(serialized.publicKeyJwk.alg).toBe('ES384');
            expect(serialized.publicKeyJwk.use).toBe('sig');
        });

        it('should include key ID in both JWKs', async () => {
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);

            expect(serialized.privateKeyJwk.kid).toBe(keyPair.kid);
            expect(serialized.publicKeyJwk.kid).toBe(keyPair.kid);
        });

        it('should have valid ISO timestamp for createdAt', async () => {
            const beforeTime = new Date();
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);
            const afterTime = new Date();

            const createdAt = new Date(serialized.createdAt);
            expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
            expect(createdAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
        });

        it('should export EC curve parameters correctly', async () => {
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);

            // ES384 uses P-384 curve
            expect(serialized.publicKeyJwk.kty).toBe('EC');
            expect(serialized.publicKeyJwk.crv).toBe('P-384');
            expect(serialized.publicKeyJwk.x).toBeDefined();
            expect(serialized.publicKeyJwk.y).toBeDefined();
        });

        it('should include private key component (d) in private JWK', async () => {
            const keyPair = await generateKeyPair();
            const serialized = await exportKeyPair(keyPair);

            expect(serialized.privateKeyJwk.d).toBeDefined();
            // Public key should NOT have d component
            expect(serialized.publicKeyJwk.d).toBeUndefined();
        });
    });

    describe('importKeyPair', () => {
        it('should import a serialized keypair', async () => {
            const original = await generateKeyPair();
            const serialized = await exportKeyPair(original);
            const imported = await importKeyPair(serialized);

            expect(imported.kid).toBe(original.kid);
            expect(imported.privateKey).toBeDefined();
            expect(imported.publicKey).toBeDefined();
        });

        it('should import keys that can sign and verify', async () => {
            const original = await generateKeyPair();
            const serialized = await exportKeyPair(original);
            const imported = await importKeyPair(serialized);

            // Sign with imported private key
            const jwt = await new jose.SignJWT({ test: 'roundtrip' })
                .setProtectedHeader({ alg: 'ES384', kid: imported.kid })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(imported.privateKey);

            // Verify with imported public key
            const { payload } = await jose.jwtVerify(jwt, imported.publicKey);
            expect(payload.test).toBe('roundtrip');
        });

        it('should produce keys compatible with original keys', async () => {
            const original = await generateKeyPair();
            const serialized = await exportKeyPair(original);
            const imported = await importKeyPair(serialized);

            // Sign with original private key
            const jwt = await new jose.SignJWT({ test: 'cross-verify' })
                .setProtectedHeader({ alg: 'ES384', kid: original.kid })
                .sign(original.privateKey);

            // Verify with imported public key
            const { payload } = await jose.jwtVerify(jwt, imported.publicKey);
            expect(payload.test).toBe('cross-verify');
        });
    });

    describe('getPublicKeyJwk', () => {
        it('should return public key in JWK format', async () => {
            const keyPair = await generateKeyPair();
            const jwk = await getPublicKeyJwk(keyPair);

            expect(jwk.kty).toBe('EC');
            expect(jwk.crv).toBe('P-384');
            expect(jwk.x).toBeDefined();
            expect(jwk.y).toBeDefined();
        });

        it('should include key ID in JWK', async () => {
            const keyPair = await generateKeyPair();
            const jwk = await getPublicKeyJwk(keyPair);

            expect(jwk.kid).toBe(keyPair.kid);
        });

        it('should include algorithm and use', async () => {
            const keyPair = await generateKeyPair();
            const jwk = await getPublicKeyJwk(keyPair);

            expect(jwk.alg).toBe('ES384');
            expect(jwk.use).toBe('sig');
        });

        it('should NOT include private key component', async () => {
            const keyPair = await generateKeyPair();
            const jwk = await getPublicKeyJwk(keyPair);

            expect(jwk.d).toBeUndefined();
        });
    });

    describe('getJwks', () => {
        it('should return JWKS with keys array', async () => {
            const keyPair = await generateKeyPair();
            const jwks = await getJwks(keyPair);

            expect(jwks).toBeDefined();
            expect(jwks.keys).toBeDefined();
            expect(Array.isArray(jwks.keys)).toBe(true);
        });

        it('should include exactly one key', async () => {
            const keyPair = await generateKeyPair();
            const jwks = await getJwks(keyPair);

            expect(jwks.keys).toHaveLength(1);
        });

        it('should include the public key with correct properties', async () => {
            const keyPair = await generateKeyPair();
            const jwks = await getJwks(keyPair);
            const key = jwks.keys[0];

            expect(key.kid).toBe(keyPair.kid);
            expect(key.alg).toBe('ES384');
            expect(key.use).toBe('sig');
            expect(key.kty).toBe('EC');
            expect(key.crv).toBe('P-384');
        });

        it('should produce valid JWKS for jose verification', async () => {
            const keyPair = await generateKeyPair();
            const jwks = await getJwks(keyPair);

            // Create a JWT
            const jwt = await new jose.SignJWT({ test: 'jwks' })
                .setProtectedHeader({ alg: 'ES384', kid: keyPair.kid })
                .sign(keyPair.privateKey);

            // Create a JWKS from the keys
            const keySetGetKey = jose.createLocalJWKSet(jwks);

            // Verify using the JWKS
            const { payload } = await jose.jwtVerify(jwt, keySetGetKey);
            expect(payload.test).toBe('jwks');
        });
    });
});
