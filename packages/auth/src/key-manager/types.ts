import type { JSONWebKeySet } from 'jose';
import type { SignOptions, VerifyOptions, VerifyResult } from '../jwt.js';

// Re-export for convenience
export type { SignOptions, VerifyOptions, VerifyResult };

/**
 * Options for key rotation
 */
export interface RotateOptions {
    /** Skip grace period, invalidate old key immediately */
    immediate?: boolean;
    /** Custom grace period in milliseconds (default: 24 hours) */
    gracePeriodMs?: number;
}

/**
 * Result of a key rotation operation
 */
export interface RotationResult {
    /** Key ID of the previous current key */
    previousKeyId: string;
    /** Key ID of the new current key */
    newKeyId: string;
    /** When the previous key will be removed from JWKS (undefined if immediate) */
    gracePeriodEndsAt?: Date;
}

/**
 * Internal state for a managed key
 */
export interface KeyState {
    /** Key identifier */
    kid: string;
    /** When the key was created */
    createdAt: number;
    /** When this key stops being valid for verification (for rotated keys) */
    expiresAt?: number;
}

/**
 * Configuration for creating a KeyManager
 */
export interface KeyManagerConfig {
    /** Type of key manager to create */
    type: 'local' | 'ephemeral';
    /** Directory for key storage (only for 'local' type) */
    keysDir?: string;
    /** Default grace period for rotation in milliseconds */
    gracePeriodMs?: number;
}

/**
 * Core KeyManager interface for all key management operations.
 *
 * Implementations handle key generation, persistence, signing, verification,
 * and rotation. This abstraction enables future cloud KMS integration.
 */
export interface IKeyManager {
    /** Sign a JWT with the current key */
    sign(options: SignOptions): Promise<string>;

    /**
     * Verify a JWT against managed keys (current and previous)
     * @param token JWT string to verify
     * @param options Optional verification options (audience)
     * @returns Verification result with payload if valid
     */
    verify(token: string, options?: VerifyOptions): Promise<VerifyResult>;

    /**
     * Get the JSON Web Key Set containing all valid public keys
     * @returns JWKS with current key and any keys still in grace period
     */
    getJwks(): Promise<JSONWebKeySet>;

    /** Get the key ID of the current signing key */
    getCurrentKeyId(): Promise<string>;

    /** Rotate to a new signing key */
    rotate(options?: RotateOptions): Promise<RotationResult>;

    /** Initialize the key manager (load or generate keys) */
    initialize(): Promise<void>;

    /**
     * Shutdown the key manager, cleaning up any resources
     * Clears rotation timers and internal state
     */
    shutdown(): Promise<void>;

    /**
     * Check if the key manager has been initialized
     * @returns true if initialize() has been called successfully
     */
    isInitialized(): boolean;
}
