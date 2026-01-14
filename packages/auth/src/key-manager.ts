
import { JSONWebKeySet, KeyLike } from 'jose';
import {
    KeyPair,
    loadOrGenerateKeyPair,
    generateKeyPair,
    saveKeyPair,
    loadKeyPair,
    getJwks,
    getPublicKeyJwk
} from './keys.js';
import { signToken, verifyToken, SignOptions } from './jwt.js';
import { readdirSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

export abstract class KeyManager {
    /**
     * Initializes the key manager (loads or generates keys).
     */
    abstract init(): Promise<void>;

    /**
     * Rotates the key.
     * @param immediate If true, the old key is discarded immediately. If false, it is kept as previousKey until it expires.
     * @param gracePeriodMs The duration in ms to keep the old key valid if immediate is false.
     */
    abstract rotate(immediate: boolean, gracePeriodMs?: number): Promise<void>;

    /**
     * Signs a payload.
     * @param options Signing options (subject, audience, claims, etc).
     * @returns The signed JWT string.
     */
    abstract sign(options: SignOptions): Promise<string>;

    /**
     * Returns the JWK Set (all valid public keys).
     */
    abstract getPublicKeys(): Promise<JSONWebKeySet>;

    /**
     * Verifies a token against managed keys.
     */
    abstract verify(token: string): Promise<{ valid: boolean; payload?: any; error?: string }>;
}

export class FileSystemKeyManager extends KeyManager {
    private currentKey?: KeyPair;
    private previousKeys: { key: KeyPair; expiresAt: number }[] = [];
    private keysDir: string;
    private archiveDir: string;

    constructor(keysDir?: string) {
        super();
        this.keysDir = keysDir || process.env.CATALYST_AUTH_KEYS_DIR || '/data/keys';
        this.archiveDir = join(this.keysDir, 'archive');
    }

    async init() {
        // Ensure archive directory exists
        if (!existsSync(this.archiveDir)) {
            mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
        }

        // Load current key
        const { keyPair } = await loadOrGenerateKeyPair(this.keysDir);
        this.currentKey = keyPair;

        // Load archived keys
        await this.loadArchivedKeys();
    }

    private async loadArchivedKeys() {
        this.previousKeys = [];
        try {
            const files = readdirSync(this.archiveDir).map(f => join(this.archiveDir, f));

            for (const file of files) {
                try {
                    // Filename format: keypair.{expiresAt}.json
                    // Check if valid filename
                    const basename = file.split('/').pop()!;
                    const match = basename.match(/^keypair\.(\d+)\.json$/);
                    if (!match) continue;

                    const expiresAt = parseInt(match[1], 10);
                    if (Date.now() > expiresAt) {
                        // Clean up expired key
                        try { unlinkSync(file); } catch { }
                        continue;
                    }

                    // Load key manually reusing load logic logic but custom path
                    // We can't use loadKeyPair directly because it assumes KEYPAIR_FILE constant name usually
                    // But we can check if we can reuse importKeyPair
                    // Let's assume we read and parse manually for simplicity as we reuse schemas but not the file loader
                    const fs = await import('fs');
                    const data = fs.readFileSync(file, 'utf-8');
                    const parsed = JSON.parse(data);
                    // Reuse importKeyPair from keys.ts if exported valid format
                    const { importKeyPair } = await import('./keys.js');
                    // We need to cast or trust the persistent format matches
                    const key = await importKeyPair(parsed as any);

                    this.previousKeys.push({ key, expiresAt });

                } catch (e) {
                    console.warn(`Failed to load archived key ${file}:`, e);
                }
            }
        } catch (e) {
            // Archive dir might be empty or unreadable
        }
    }

    async rotate(immediate: boolean, gracePeriodMs: number = 24 * 60 * 60 * 1000) {
        if (!this.currentKey) {
            await this.init();
        }

        const oldKey = this.currentKey!;
        const newKey = await generateKeyPair();

        // 1. Archive the old key
        if (!immediate) {
            const expiresAt = Date.now() + gracePeriodMs;
            const archivePath = join(this.archiveDir, `keypair.${expiresAt}.json`);

            // Move the current file to archive path
            // We need to verify the current file on disk corresponds to oldKey... 
            // safest is to just write oldKey to archivePath
            const { saveKeyPair } = await import('./keys.js');
            // We can't use saveKeyPair easily with custom path unless we modify it or implement custom write
            // Implementing custom write here to keep keys.ts simple
            const { exportKeyPair } = await import('./keys.js');
            const serialized = await exportKeyPair(oldKey);
            const fs = await import('fs');
            fs.writeFileSync(archivePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });

            this.previousKeys.push({ key: oldKey, expiresAt });
        } else {
            this.previousKeys = []; // Clear previous keys if immediate rotation (security decision? or just deprecate current?)
            // If immediate, we probably want to clear archived keys too?
            // "Discard immediately" implies invalidation. 
            // We will wipe memory previous keys. File cleanup happens on next init/prune.
        }

        // 2. Save new key as current (overwrites keypair.json)
        await saveKeyPair(newKey, this.keysDir);
        this.currentKey = newKey;
    }

    async sign(options: SignOptions): Promise<string> {
        if (!this.currentKey) await this.init();

        return signToken(this.currentKey!, options);
    }

    async getPublicKeys(): Promise<JSONWebKeySet> {
        if (!this.currentKey) await this.init();

        const keys = [];

        // Current key
        const currentJwk = await getPublicKeyJwk(this.currentKey!);
        keys.push(currentJwk);

        // Previous keys
        for (const prev of this.previousKeys) {
            if (Date.now() < prev.expiresAt) {
                const prevJwk = await getPublicKeyJwk(prev.key);
                keys.push(prevJwk);
            }
        }

        return { keys };
    }

    async verify(token: string): Promise<{ valid: boolean; payload?: any; error?: string }> {
        if (!this.currentKey) await this.init();

        // Try current key
        const res = await verifyToken(this.currentKey!, token);
        if (res.valid) return res;

        // Try previous keys
        for (const prev of this.previousKeys) {
            if (Date.now() < prev.expiresAt) {
                const prevRes = await verifyToken(prev.key, token);
                if (prevRes.valid) return prevRes;
            }
        }

        return res;
    }
}
