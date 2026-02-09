import type { JSONWebKeySet } from 'jose'
import { decodeProtectedHeader } from 'jose'

import type { KeyPair } from '../keys.js'
import { generateKeyPair, getPublicKeyJwk } from '../keys.js'
import { signToken, verifyToken } from '../jwt.js'
import type {
  IKeyManager,
  SignOptions,
  VerifyOptions,
  VerifyResult,
  RotateOptions,
  RotationResult,
  KeyState,
} from './types.js'

/** Default grace period: 24 hours */
const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/** Managed key with expiration tracking */
export interface ManagedKey {
  keyPair: KeyPair
  state: KeyState
}

/**
 * BaseKeyManager - Abstract base class for key management implementations
 *
 * Provides shared logic for signing, verification, JWKS generation, and rotation.
 * Subclasses implement persistence-specific behavior via initialize() and optional hooks.
 */
export abstract class BaseKeyManager implements IKeyManager {
  protected currentKey: ManagedKey | null = null
  protected previousKeys: ManagedKey[] = []
  protected keysByKid: Map<string, ManagedKey> = new Map()
  protected _initialized = false
  protected rotationPromise: Promise<RotationResult> | null = null
  protected readonly defaultGracePeriodMs: number

  constructor(options?: { gracePeriodMs?: number }) {
    this.defaultGracePeriodMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
  }

  isInitialized(): boolean {
    return this._initialized
  }

  /**
   * Initialize the key manager (load or generate keys)
   * Subclasses implement persistence-specific initialization.
   */
  abstract initialize(): Promise<void>

  /**
   * Shutdown the key manager, clearing all state.
   * Subclasses can override onShutdown() for cleanup.
   */
  async shutdown(): Promise<void> {
    await this.onShutdown()
    this.currentKey = null
    this.previousKeys = []
    this.keysByKid.clear()
    this._initialized = false
  }

  /**
   * Hook for subclass-specific shutdown cleanup.
   * Default implementation does nothing.
   */
  protected async onShutdown(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Hook called during rotation for persistence operations.
   * Default implementation does nothing (suitable for in-memory managers).
   */
  protected async onRotate(
    _oldKey: ManagedKey,
    _newKey: ManagedKey,
    _immediate: boolean
  ): Promise<void> {
    // Default: no persistence
  }

  async sign(options: SignOptions): Promise<string> {
    const key = this.getCurrentKey()
    return signToken(key.keyPair, options)
  }

  async verify(token: string, options?: VerifyOptions): Promise<VerifyResult> {
    this.ensureInitialized('verify')

    // Extract kid from token header for targeted lookup
    const kid = this.extractKidFromToken(token)

    if (kid) {
      const managedKey = this.keysByKid.get(kid)
      if (managedKey) {
        // Check if key is still valid (not expired)
        if (managedKey.state.expiresAt && Date.now() > managedKey.state.expiresAt) {
          return { valid: false, error: 'Invalid token' }
        }
        return verifyToken(managedKey.keyPair, token, options)
      }
    }

    // Fallback: try current key first, then previous keys
    const key = this.getCurrentKey()
    const currentResult = await verifyToken(key.keyPair, token, options)
    if (currentResult.valid) {
      return currentResult
    }

    // Try previous keys (only non-expired ones)
    for (const prev of this.previousKeys) {
      if (!prev.state.expiresAt || Date.now() < prev.state.expiresAt) {
        const prevResult = await verifyToken(prev.keyPair, token, options)
        if (prevResult.valid) {
          return prevResult
        }
      }
    }

    return { valid: false, error: 'Invalid token' }
  }

  async getJwks(): Promise<JSONWebKeySet> {
    const key = this.getCurrentKey()
    const keys = []

    // Current key
    const currentJwk = await getPublicKeyJwk(key.keyPair)
    keys.push(currentJwk)

    // Previous keys (only non-expired ones)
    for (const prev of this.previousKeys) {
      if (!prev.state.expiresAt || Date.now() < prev.state.expiresAt) {
        const prevJwk = await getPublicKeyJwk(prev.keyPair)
        keys.push(prevJwk)
      }
    }

    return { keys }
  }

  async getCurrentKeyId(): Promise<string> {
    const key = this.getCurrentKey()
    return key.keyPair.kid
  }

  async rotate(options?: RotateOptions): Promise<RotationResult> {
    this.ensureInitialized('rotate')

    // If rotation already in progress, return that promise.
    // This ensures concurrent callers get the same result rather than racing.
    if (this.rotationPromise) {
      return this.rotationPromise
    }

    this.rotationPromise = this.doRotate(options)
    try {
      return await this.rotationPromise
    } finally {
      this.rotationPromise = null
    }
  }

  private async doRotate(options?: RotateOptions): Promise<RotationResult> {
    const immediate = options?.immediate ?? false
    const gracePeriodMs = options?.gracePeriodMs ?? this.defaultGracePeriodMs

    const oldKey = this.getCurrentKey()
    const previousKeyId = oldKey.keyPair.kid

    // Generate new key
    const newKeyPair = await generateKeyPair()
    const newKey: ManagedKey = {
      keyPair: newKeyPair,
      state: {
        kid: newKeyPair.kid,
        createdAt: Date.now(),
      },
    }

    let gracePeriodEndsAt: Date | undefined

    if (!immediate) {
      // Keep old key with expiration
      const expiresAt = Date.now() + gracePeriodMs
      gracePeriodEndsAt = new Date(expiresAt)
      oldKey.state.expiresAt = expiresAt
      this.previousKeys.push(oldKey)
    } else {
      // Immediate rotation: remove old key
      this.keysByKid.delete(previousKeyId)
      this.previousKeys = []
    }

    // Call subclass hook for persistence
    await this.onRotate(oldKey, newKey, immediate)

    // Update state
    this.currentKey = newKey
    this.keysByKid.set(newKeyPair.kid, newKey)

    return {
      previousKeyId,
      newKeyId: newKeyPair.kid,
      gracePeriodEndsAt,
    }
  }

  /**
   * Get current key with type narrowing.
   * Throws if not initialized.
   */
  protected getCurrentKey(): ManagedKey {
    if (!this._initialized || !this.currentKey) {
      throw new Error('KeyManager must be initialized before use')
    }
    return this.currentKey
  }

  /**
   * Ensure the manager is initialized before operations
   */
  protected ensureInitialized(operation: string): void {
    if (!this._initialized) {
      throw new Error(`KeyManager must be initialized before calling ${operation}()`)
    }
  }

  /**
   * Extract kid from JWT header
   */
  protected extractKidFromToken(token: string): string | null {
    try {
      const header = decodeProtectedHeader(token)
      return header.kid ?? null
    } catch {
      return null
    }
  }
}
