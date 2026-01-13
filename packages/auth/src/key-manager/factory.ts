import type { IKeyManager, KeyManagerConfig } from './types.js';
import { FileSystemKeyManager } from './local.js';
import { EphemeralKeyManager } from './ephemeral.js';

/**
 * Create a KeyManager instance based on configuration
 *
 * @param config Configuration specifying type and options
 * @returns Configured KeyManager (not yet initialized)
 *
 * @example
 * ```typescript
 * // Create from environment
 * const keyManager = createKeyManager({
 *     type: process.env.KEY_MANAGER_TYPE || 'local',
 *     keysDir: process.env.CATALYST_AUTH_KEYS_DIR,
 * });
 * await keyManager.initialize();
 * ```
 */
export function createKeyManager(config: KeyManagerConfig): IKeyManager {
    const { type, keysDir, gracePeriodMs } = config;

    switch (type) {
        case 'local':
            return new FileSystemKeyManager(keysDir, { gracePeriodMs });

        case 'ephemeral':
            return new EphemeralKeyManager({ gracePeriodMs });

        default:
            throw new Error(`Unknown KeyManager type: ${type}. Supported types: 'local', 'ephemeral'`);
    }
}

/**
 * Create a KeyManager from environment variables
 *
 * Environment variables:
 * - KEY_MANAGER_TYPE: 'local' (default) or 'ephemeral'
 * - CATALYST_AUTH_KEYS_DIR: Directory for key storage (local only)
 *
 * @returns Configured KeyManager (not yet initialized)
 */
export function createKeyManagerFromEnv(): IKeyManager {
    const type = (process.env.KEY_MANAGER_TYPE as 'local' | 'ephemeral') || 'local';
    const keysDir = process.env.CATALYST_AUTH_KEYS_DIR;

    return createKeyManager({ type, keysDir });
}
