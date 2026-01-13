import { generateKeyPair } from '../keys.js';
import { BaseKeyManager } from './base.js';

/**
 * EphemeralKeyManager - In-memory key management
 *
 * Keys are generated fresh on each initialization and only exist in memory.
 */
export class EphemeralKeyManager extends BaseKeyManager {
    constructor(options?: { gracePeriodMs?: number }) {
        super(options);
    }

    async initialize(): Promise<void> {
        if (this._initialized) {
            throw new Error('KeyManager already initialized');
        }

        const keyPair = await generateKeyPair();

        this.currentKey = {
            keyPair,
            state: {
                kid: keyPair.kid,
                createdAt: Date.now(),
            },
        };
        this.keysByKid.set(keyPair.kid, this.currentKey);

        this._initialized = true;
    }

    // Uses default onRotate() and shutdown() from BaseKeyManager
}
