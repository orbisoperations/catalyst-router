
import { JSONWebKeySet, KeyLike } from 'jose';
import {
    KeyPair,
    loadOrGenerateKeyPair,
    generateKeyPair,
    saveKeyPair,
    getJwks,
    getPublicKeyJwk
} from './keys.js';
import { signToken, verifyToken, SignOptions } from './jwt.js';

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
    private previousKey?: KeyPair;
    private previousKeyExpiresAt?: number;
    private keysDir: string;

    constructor(keysDir?: string) {
        super();
        this.keysDir = keysDir || process.env.CATALYST_AUTH_KEYS_DIR || '/data/keys';
    }

    async init() {
        if (!this.currentKey) {
            const { keyPair } = await loadOrGenerateKeyPair(this.keysDir);
            this.currentKey = keyPair;
        }
    }

    async rotate(immediate: boolean, gracePeriodMs: number = 24 * 60 * 60 * 1000) {
        if (!this.currentKey) {
            await this.init();
        }

        const oldKey = this.currentKey!;
        const newKey = await generateKeyPair();

        // Persist the new key (overwrites the file)
        await saveKeyPair(newKey, this.keysDir);

        this.currentKey = newKey;

        if (immediate) {
            this.previousKey = undefined;
            this.previousKeyExpiresAt = undefined;
        } else {
            this.previousKey = oldKey;
            this.previousKeyExpiresAt = Date.now() + gracePeriodMs;
        }
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

        // Previous key if valid
        if (this.previousKey && this.previousKeyExpiresAt && Date.now() < this.previousKeyExpiresAt) {
            const prevJwk = await getPublicKeyJwk(this.previousKey);
            keys.push(prevJwk);
        }

        return { keys };
    }

    async verify(token: string): Promise<{ valid: boolean; payload?: any; error?: string }> {
        if (!this.currentKey) await this.init();

        // Try current key
        const res = await verifyToken(this.currentKey!, token);
        if (res.valid) return res;

        // Try previous key if valid and error wasn't just "expired" (though VerifyResult doesn't distinguish signature fail vs exp easily without error checks, jwt.ts verifyToken returns generic error for signature fail)
        // Actually verifyToken checks logic.

        if (this.previousKey && this.previousKeyExpiresAt && Date.now() < this.previousKeyExpiresAt) {
            const prevRes = await verifyToken(this.previousKey, token);
            if (prevRes.valid) return prevRes;
        }

        return res;
    }
}
