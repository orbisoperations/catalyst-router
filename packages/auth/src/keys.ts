import * as jose from 'jose';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { KeyObject } from 'node:crypto';

// jose v6 uses native platform key types
type CryptoKeyLike = CryptoKey | KeyObject;

export interface KeyPair {
    privateKey: CryptoKeyLike;
    publicKey: CryptoKeyLike;
    kid: string;
}

export interface SerializedKeyPair {
    privateKeyJwk: jose.JWK;
    publicKeyJwk: jose.JWK;
    kid: string;
    createdAt: string;
}

// JWK schema - must have kty, allow any other properties (jose validates the rest)
const JwkSchema = z.object({ kty: z.string() }).catchall(z.unknown());

// Zod schema for validating loaded keypair files
const SerializedKeyPairSchema = z.object({
    privateKeyJwk: JwkSchema,
    publicKeyJwk: JwkSchema,
    kid: z.string().min(1),
    createdAt: z.iso.datetime(),
});

const DEFAULT_KEYS_DIR = process.env.CATALYST_AUTH_KEYS_DIR || '/data/keys';
const KEYPAIR_FILE = 'keypair.json';
const ALGORITHM = 'ES384' as const;

/**
 * Add standard metadata to a JWK (kid, alg, use)
 */
function decorateJwk(jwk: jose.JWK, kid: string): jose.JWK {
    return {
        ...jwk,
        kid,
        alg: ALGORITHM,
        use: 'sig',
    };
}

/**
 * Generate a new ECDSA ES384 keypair with a unique key ID
 * Key ID is derived from the JWK thumbprint (RFC 7638) for deterministic, secure identification
 */
export async function generateKeyPair(): Promise<KeyPair> {
    const { publicKey, privateKey } = await jose.generateKeyPair(ALGORITHM, {
        extractable: true,
    });

    // Use JWK thumbprint as key ID (RFC 7638) - deterministic and standard
    const publicKeyJwk = await jose.exportJWK(publicKey);
    const kid = await jose.calculateJwkThumbprint(publicKeyJwk, 'sha256');

    return {
        privateKey,
        publicKey,
        kid,
    };
}

/**
 * Export a keypair to JWK format for persistence
 */
export async function exportKeyPair(keyPair: KeyPair): Promise<SerializedKeyPair> {
    const [privateKeyJwk, publicKeyJwk] = await Promise.all([
        jose.exportJWK(keyPair.privateKey),
        jose.exportJWK(keyPair.publicKey),
    ]);

    return {
        privateKeyJwk: decorateJwk(privateKeyJwk, keyPair.kid),
        publicKeyJwk: decorateJwk(publicKeyJwk, keyPair.kid),
        kid: keyPair.kid,
        createdAt: new Date().toISOString(),
    };
}

/**
 * Import a keypair from JWK format
 */
export async function importKeyPair(serialized: SerializedKeyPair): Promise<KeyPair> {
    const [privateKey, publicKey] = await Promise.all([
        jose.importJWK(serialized.privateKeyJwk, ALGORITHM),
        jose.importJWK(serialized.publicKeyJwk, ALGORITHM),
    ]);

    // jose.importJWK returns CryptoKey for asymmetric keys (Uint8Array only for symmetric 'oct' keys)
    return {
        privateKey: privateKey as CryptoKeyLike,
        publicKey: publicKey as CryptoKeyLike,
        kid: serialized.kid,
    };
}

/**
 * Save a keypair to disk with secure permissions
 * Uses atomic write (temp file + rename) to prevent TOCTOU race conditions
 */
export async function saveKeyPair(keyPair: KeyPair, keysDir: string = DEFAULT_KEYS_DIR): Promise<void> {
    const serialized = await exportKeyPair(keyPair);
    const filePath = join(keysDir, KEYPAIR_FILE);
    const tempPath = join(keysDir, `.keypair.${process.pid}.tmp`);

    // Ensure directory exists with restricted permissions
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });

    try {
        // Write to temp file with secure permissions (owner read/write only)
        writeFileSync(tempPath, JSON.stringify(serialized, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
        });

        
        renameSync(tempPath, filePath);
    } catch (err) {
        // Clean up temp file on failure
        try {
            unlinkSync(tempPath);
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}

/**
 * Load a keypair from disk with validation
 * Handles missing file gracefully, validates structure before use
 */
export async function loadKeyPair(keysDir: string = DEFAULT_KEYS_DIR): Promise<KeyPair | null> {
    const filePath = join(keysDir, KEYPAIR_FILE);

    let data: string;
    try {
        data = readFileSync(filePath, 'utf-8');
    } catch (err) {
        // File doesn't exist - not an error, just no existing keypair
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw err;
    }

    // Parse and validate JSON structure
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        throw new Error(`Invalid JSON in keypair file: ${filePath}`);
    }

    // Validate against schema
    const result = SerializedKeyPairSchema.safeParse(parsed);
    if (!result.success) {
        throw new Error(
            `Invalid keypair file structure in ${filePath}: ${result.error.issues.map(i => i.message).join(', ')}`
        );
    }

    return importKeyPair(result.data as SerializedKeyPair);
}

/**
 * Load existing keypair or generate a new one
 * Returns { keyPair, generated: boolean } so caller can log if needed
 */
export async function loadOrGenerateKeyPair(keysDir: string = DEFAULT_KEYS_DIR): Promise<{ keyPair: KeyPair; generated: boolean }> {
    const existing = await loadKeyPair(keysDir);

    if (existing) {
        return { keyPair: existing, generated: false };
    }

    const keyPair = await generateKeyPair();
    await saveKeyPair(keyPair, keysDir);

    return { keyPair, generated: true };
}

/**
 * Get the public key in JWK format (for JWKS endpoint)
 */
export async function getPublicKeyJwk(keyPair: KeyPair): Promise<jose.JWK> {
    const jwk = await jose.exportJWK(keyPair.publicKey);
    return decorateJwk(jwk, keyPair.kid);
}

/**
 * Get the JWKS (JSON Web Key Set) containing all public keys
 */
export async function getJwks(keyPair: KeyPair): Promise<jose.JSONWebKeySet> {
    const publicKeyJwk = await getPublicKeyJwk(keyPair);
    return {
        keys: [publicKeyJwk],
    };
}
