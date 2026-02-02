import type { JSONWebKeySet } from 'jose'
import type {
  IKeyManager as IBaseKeyManager,
  SignOptions,
  VerifyOptions,
  VerifyResult,
  RotateOptions,
  RotationResult
} from '@catalyst/authorization'

// Re-export for convenience
export type { SignOptions, VerifyOptions, VerifyResult, RotateOptions, RotationResult }

/**
 * Internal state for a managed key
 */
export interface KeyState {
  /** Key identifier */
  kid: string
  /** When the key was created */
  createdAt: number
  /** When this key stops being valid for verification (for rotated keys) */
  expiresAt?: number
}

/**
 * Configuration for creating a KeyManager
 */
export interface KeyManagerConfig {
  /** Type of key manager to create */
  type: 'local' | 'ephemeral'
  /** Directory for key storage (only for 'local' type) */
  keysDir?: string
  /** Default grace period for rotation in milliseconds */
  gracePeriodMs?: number
}

/**
 * Core KeyManager interface for all key management operations.
 */
export interface IKeyManager extends IBaseKeyManager { }
