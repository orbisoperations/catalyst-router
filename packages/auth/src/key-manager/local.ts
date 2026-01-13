import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'fs/promises';
import { join } from 'path';

import {
    loadOrGenerateKeyPair,
    saveKeyPair,
    exportKeyPair,
    importKeyPair,
    type SerializedKeyPair,
} from '../keys.js';
import { BaseKeyManager, type ManagedKey } from './base.js';

/**
 * FileSystemKeyManager - File-based key management with rotation support
 *
 * Keys are stored on the local filesystem:
 * - Current key: {keysDir}/keypair.json
 * - Archived keys: {keysDir}/archive/keypair.{expiresAt}.json
 */
export class FileSystemKeyManager extends BaseKeyManager {
    private readonly archiveDir: string;

    constructor(
        private readonly keysDir: string = process.env.CATALYST_AUTH_KEYS_DIR || '/data/keys',
        options?: { gracePeriodMs?: number }
    ) {
        super(options);
        this.archiveDir = join(keysDir, 'archive');
    }

    async initialize(): Promise<void> {
        if (this._initialized) {
            throw new Error('KeyManager is already initialized');
        }

        // Ensure archive directory exists
        await mkdir(this.archiveDir, { recursive: true, mode: 0o700 }).catch(() => {
            // Directory may already exist
        });

        // Load or generate current key
        const { keyPair, generated } = await loadOrGenerateKeyPair(this.keysDir);

        // Get actual creation time from file if key was loaded
        let createdAt = Date.now();
        if (!generated) {
            try {
                const keyPath = join(this.keysDir, 'keypair.json');
                const stats = await stat(keyPath);
                const birthtime = stats.birthtime.getTime();
                // Validate birthtime - some filesystems return 0 or ctime instead
                // Use a reasonable minimum date (2020) to detect invalid values
                const minValidTime = new Date('2020-01-01').getTime();
                if (birthtime > minValidTime && birthtime <= Date.now()) {
                    createdAt = birthtime;
                }
            } catch {
                // Fall back to now if we can't get file stats
            }
        }

        this.currentKey = {
            keyPair,
            state: {
                kid: keyPair.kid,
                createdAt,
            },
        };
        this.keysByKid.set(keyPair.kid, this.currentKey);

        // Load archived keys
        await this.loadArchivedKeys();

        this._initialized = true;
    }

    protected override async onRotate(oldKey: ManagedKey, newKey: ManagedKey, immediate: boolean): Promise<void> {
        if (!immediate) {
            await this.archiveKey(oldKey, oldKey.state.expiresAt!);
        } else {
            await this.clearArchive();
        }

        await saveKeyPair(newKey.keyPair, this.keysDir);
    }

    /**
     * Load archived keys from disk
     */
    private async loadArchivedKeys(): Promise<void> {
        this.previousKeys = [];

        let files: string[];
        try {
            files = await readdir(this.archiveDir);
        } catch {
            return; // Archive directory doesn't exist or can't be read
        }

        for (const filename of files) {
            const match = filename.match(/^keypair\.(\d+)\.json$/);
            if (!match) continue;

            const expiresAt = parseInt(match[1], 10);

            // Skip and clean up expired keys
            if (Date.now() > expiresAt) {
                await unlink(join(this.archiveDir, filename)).catch(() => {});
                continue;
            }

            try {
                const filePath = join(this.archiveDir, filename);
                const data = await readFile(filePath, 'utf-8');
                const parsed = JSON.parse(data) as SerializedKeyPair;
                const keyPair = await importKeyPair(parsed);

                const managedKey: ManagedKey = {
                    keyPair,
                    state: {
                        kid: keyPair.kid,
                        createdAt: new Date(parsed.createdAt).getTime(),
                        expiresAt,
                    },
                };

                this.previousKeys.push(managedKey);
                this.keysByKid.set(keyPair.kid, managedKey);
            } catch {
                // Skip keys that fail to load - could log this
            }
        }
    }

    /**
     * Archive a key to disk
     */
    private async archiveKey(managedKey: ManagedKey, expiresAt: number): Promise<void> {
        const archivePath = join(this.archiveDir, `keypair.${expiresAt}.json`);

        // Preserve original creation time when archiving
        const createdAt = new Date(managedKey.state.createdAt);
        const serialized = await exportKeyPair(managedKey.keyPair, createdAt);
        await writeFile(archivePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
    }

    /**
     * Clear all archived keys
     */
    private async clearArchive(): Promise<void> {
        let files: string[];
        try {
            files = await readdir(this.archiveDir);
        } catch {
            return;
        }

        await Promise.all(
            files.map(filename => unlink(join(this.archiveDir, filename)).catch(() => {}))
        );
    }
}
