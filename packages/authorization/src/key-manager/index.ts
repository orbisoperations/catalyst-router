import type { JSONWebKeySet } from 'jose'
import type { ValidationResult } from '@catalyst/types'

/**
 * Options for signing a JWT
 */
export interface SignOptions {
  subject: string
  audience?: string | string[]
  /** Expiration time in milliseconds (unix timestamp * 1000) */
  expiresAt?: number
  claims?: Record<string, unknown>
}

/**
 * Options for verifying a JWT
 */
export interface VerifyOptions {
  audience?: string | string[]
}

/**
 * Result of token verification
 * @deprecated Use ValidationResult<Record<string, unknown>> directly from @catalyst/types
 */
export type VerifyResult = ValidationResult<Record<string, unknown>>

/**
 * Options for key rotation
 */
export interface RotateOptions {
  immediate?: boolean
  gracePeriodMs?: number
}

/**
 * Result of a key rotation operation
 */
export interface RotationResult {
  previousKeyId: string
  newKeyId: string
  gracePeriodEndsAt?: Date
}

/**
 * Core KeyManager interface for all key management operations.
 */
export interface IKeyManager {
  /** Sign a JWT with the current key */
  sign(options: SignOptions): Promise<string>

  /** Verify a JWT against managed keys */
  verify(token: string, options?: VerifyOptions): Promise<VerifyResult>

  /** Get the JSON Web Key Set containing all valid public keys */
  getJwks(): Promise<JSONWebKeySet>

  /** Get the key ID of the current signing key */
  getCurrentKeyId(): Promise<string>

  /** Rotate to a new signing key */
  rotate(options?: RotateOptions): Promise<RotationResult>

  /** Initialize the key manager */
  initialize(): Promise<void>

  /** Shutdown the key manager */
  shutdown(): Promise<void>

  /** Check if the key manager has been initialized */
  isInitialized(): boolean
}

/**
 * Interface for persisting key material.
 */
export interface IKeyStore {
  /** Save all keys as a JWKS */
  saveKeys(jwks: JSONWebKeySet): Promise<void>
  /** Load keys as a JWKS */
  loadKeys(): Promise<JSONWebKeySet | null>
}
