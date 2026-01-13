import { verifyToken, decodeToken, CLOCK_TOLERANCE } from './jwt.js';
import type { KeyPair } from './keys.js';

const CLOCK_TOLERANCE_MS = CLOCK_TOLERANCE * 1000;

/**
 * Interface for JTI revocation stores
 * Implementations can be in-memory, Redis-backed, etc.
 */
export interface RevocationStore {
    /** Add a JTI to the revocation list. Evicts oldest entries if at capacity. */
    revoke(jti: string, expiresAt: Date): void;
    isRevoked(jti: string): boolean;
    /** @returns number of entries removed */
    cleanup(): number;
    readonly size: number;
    readonly maxSize: number;
}

export interface RevocationStoreOptions {
    maxSize?: number;
}

/**
 * In-memory JTI revocation store
 * TODO: Gotta deal with this ok ok
 *
 */
export class InMemoryRevocationStore implements RevocationStore {
    // Map of jti -> expiry timestamp (ms)
    private revoked = new Map<string, number>();
    readonly maxSize: number;

    constructor(options?: RevocationStoreOptions) {
        this.maxSize = options?.maxSize ?? 100_000;
    }

    revoke(jti: string, expiresAt: Date): void {
        this.revoked.set(jti, expiresAt.getTime());

        if (this.revoked.size > this.maxSize) {
            this.cleanup();
        }

        const toEvict = this.revoked.size - this.maxSize;
        // This gets gross when it is full but also see the earlier todo
        if (toEvict > 0) {
            const entries = [...this.revoked.entries()]
                .filter(([id]) => id !== jti)
                .sort((a, b) => a[1] - b[1]);

            for (let i = 0; i < toEvict && i < entries.length; i++) {
                this.revoked.delete(entries[i][0]);
            }
        }
    }

    isRevoked(jti: string): boolean {
        const expiresAt = this.revoked.get(jti);
        if (expiresAt === undefined) {
            return false;
        }
        // Expired entries get deleted, not just ignored
        if (expiresAt + CLOCK_TOLERANCE_MS < Date.now()) {
            this.revoked.delete(jti);
            return false;
        }
        return true;
    }

    cleanup(): number {
        const now = Date.now();
        const toDelete: string[] = [];
        for (const [jti, expiresAt] of this.revoked) {
            // Add tolerance to match jwt.ts verification behavior
            if (expiresAt + CLOCK_TOLERANCE_MS < now) {
                toDelete.push(jti);
            }
        }
        for (const jti of toDelete) {
            this.revoked.delete(jti);
        }
        return toDelete.length;
    }

    get size(): number {
        return this.revoked.size;
    }
}

/**
 * Result of revoking a token
 */
export type RevokeTokenResult =
    | { success: true }
    | { success: false; error: string };

/**
 * Options for revoking a token
 */
export interface RevokeTokenOptions {
    /** The revocation store */
    store: RevocationStore;
    /** KeyPair for signature verification */
    keyPair: KeyPair;
    /** Token to revoke */
    token: string;
    /** Caller's auth token for authorization */
    authToken: string;
}

/**
 * Check if caller is authorized to revoke a token
 * Returns true if:
 * - authToken.sub matches token.sub (revoking own token), OR
 * - authToken has role: 'admin' claim
 * TODO: roles n orgs
 */
export function isAuthorizedToRevoke(
    authPayload: Record<string, unknown>,
    tokenPayload: Record<string, unknown>
): boolean {
    if (authPayload.role === 'admin') {
        return true;
    }
    if (
        typeof authPayload.sub === 'string' &&
        typeof tokenPayload.sub === 'string' &&
        authPayload.sub === tokenPayload.sub
    ) {
        return true;
    }
    return false;
}

/**
 * Revoke a token with authorization check
 *
 * Authorization: caller must provide authToken proving identity.
 * Revocation allowed if:
 * - authToken.sub matches token.sub (revoking own token), OR
 * - authToken has role: 'admin' claim (admin can revoke any token)
 *
 * Note: We only verify authToken (to prove caller identity). The target token
 * is just decoded - we don't care if its signature is valid. If someone wants
 * to revoke an expired or key-rotated token, that's fine.
 */
export async function revokeToken(opts: RevokeTokenOptions): Promise<RevokeTokenResult> {
    const { store, keyPair, token, authToken } = opts;

    // Verify auth token to prove caller identity
    const authResult = await verifyToken(keyPair, authToken);
    if (!authResult.valid) {
        return { success: false, error: 'Invalid auth token' };
    }

    // Just decode target token - no signature verification needed
    const decoded = decodeToken(token);
    if (!decoded) {
        return { success: false, error: 'Malformed token' };
    }

    // Authorization check
    if (!isAuthorizedToRevoke(authResult.payload, decoded.payload as Record<string, unknown>)) {
        return { success: false, error: 'Not authorized to revoke this token' };
    }

    const { jti, exp } = decoded.payload;

    if (typeof jti !== 'string' || jti === '') {
        return { success: false, error: 'Token missing jti claim' };
    }
    if (typeof exp !== 'number') {
        return { success: false, error: 'Token missing exp claim' };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (exp + CLOCK_TOLERANCE <= nowSeconds) {
        return { success: false, error: 'Token already expired' };
    }

    store.revoke(jti, new Date(exp * 1000));
    return { success: true };
}
