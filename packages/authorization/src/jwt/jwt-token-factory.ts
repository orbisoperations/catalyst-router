import type { JSONWebKeySet } from 'jose'
import type {
  IKeyStore,
  RotateOptions,
  RotationResult,
  VerifyResult,
} from '../key-manager/index.js'
import type { MintOptions, TokenRecord, TokenStore } from './index.js'
import { PersistentLocalKeyManager } from '../key-manager/persistent.js'
import { BunSqliteKeyStore } from '../key-manager/sqlite-key-store.js'
import { BunSqliteTokenStore } from './local/sqlite-store.js'
import { LocalTokenManager } from './local/index.js'

/**
 * Configuration for local SQLite-backed persistence.
 */
export interface LocalPersistenceConfig {
  /** Path to the SQLite database file for key storage. Default: `'keys.db'` */
  keyDbFile?: string
  /** Path to the SQLite database file for token tracking. Default: `'tokens.db'` */
  tokenDbFile?: string
  /** Node identifier injected into minted tokens. */
  nodeId?: string
  /** Grace period in milliseconds for key rotation. Default: 24 hours (86400000) */
  gracePeriodMs?: number
  /** JWT issuer claim (iss). Injected into every signed token when set. */
  issuer?: string
}

/**
 * Configuration for JWTTokenFactory.
 *
 * Currently supports `local` SQLite-backed persistence.
 * All fields are optional — sane defaults are applied.
 */
export interface JWTTokenFactoryConfig {
  local?: LocalPersistenceConfig
}

/**
 * Batteries-included facade for JWT token lifecycle management.
 *
 * Wires together key management, token signing/verification, and revocation
 * behind a single config-driven API. Consumers only need this class — all
 * persistence is handled internally via SQLite.
 *
 * @example
 * ```typescript
 * // Production — config with overrides
 * const factory = new JWTTokenFactory({
 *   local: {
 *     keyDbFile: '/data/keys.db',
 *     tokenDbFile: '/data/tokens.db',
 *     nodeId: 'node-a',
 *   },
 * })
 * await factory.initialize()
 *
 * const token = await factory.mint({ subject: 'alice', principal: Principal.USER, entity: { ... } })
 * const result = await factory.verify(token)  // auto-checks revocation
 * await factory.revoke({ jti: '...' })
 *
 * // Minimal — all defaults (SQLite files in cwd)
 * const factory = new JWTTokenFactory()
 * await factory.initialize()
 *
 * // Testing — ephemeral in-memory stores
 * const factory = JWTTokenFactory.ephemeral({ nodeId: 'test-node' })
 * await factory.initialize()
 * ```
 */
export class JWTTokenFactory {
  private readonly keyManager: PersistentLocalKeyManager
  private readonly tokenManager: LocalTokenManager

  constructor(config?: JWTTokenFactoryConfig) {
    const local = config?.local ?? {}
    const keyDbFile = local.keyDbFile ?? 'keys.db'
    const tokenDbFile = local.tokenDbFile ?? 'tokens.db'

    const keyStore: IKeyStore = new BunSqliteKeyStore(keyDbFile)
    const tokenStore: TokenStore = new BunSqliteTokenStore(tokenDbFile)

    this.keyManager = new PersistentLocalKeyManager(keyStore, {
      gracePeriodMs: local.gracePeriodMs,
      issuer: local.issuer,
    })
    this.tokenManager = new LocalTokenManager(this.keyManager, tokenStore, local.nodeId)
  }

  /**
   * Create an ephemeral factory with in-memory SQLite stores.
   * Useful for testing — no files are created on disk.
   */
  static ephemeral(options?: { nodeId?: string; gracePeriodMs?: number }): JWTTokenFactory {
    return new JWTTokenFactory({
      local: {
        keyDbFile: ':memory:',
        tokenDbFile: ':memory:',
        nodeId: options?.nodeId,
        gracePeriodMs: options?.gracePeriodMs,
      },
    })
  }

  /** Initialize key management. Must be called before any other operation. */
  async initialize(): Promise<void> {
    await this.keyManager.initialize()
  }

  /** Shutdown and release key material from memory. */
  async shutdown(): Promise<void> {
    await this.keyManager.shutdown()
  }

  /** Check if the factory has been initialized. */
  isInitialized(): boolean {
    return this.keyManager.isInitialized()
  }

  /** Mint a new JWT with entity/principal bindings. The token is tracked for revocation. */
  async mint(options: MintOptions): Promise<string> {
    return this.tokenManager.mint(options)
  }

  /**
   * Verify a JWT. Checks cryptographic signature AND revocation status.
   * Returns `{ valid: true, payload }` or `{ valid: false, error }`.
   */
  async verify(token: string, options?: { audience?: string | string[] }): Promise<VerifyResult> {
    return this.tokenManager.verify(token, options)
  }

  /** Revoke tokens by JTI, SAN, or both. */
  async revoke(options: { jti?: string; san?: string }): Promise<void> {
    return this.tokenManager.revoke(options)
  }

  /** Check if a specific token is revoked by its JTI. */
  async isRevoked(jti: string): Promise<boolean> {
    return this.tokenManager.getStore().isRevoked(jti)
  }

  /** Look up a tracked token's metadata by JTI. Returns null if not found. */
  async findToken(jti: string): Promise<TokenRecord | null> {
    return this.tokenManager.getStore().findToken(jti)
  }

  /** Rotate the signing key. The previous key enters a grace period for verification. */
  async rotate(options?: RotateOptions): Promise<RotationResult> {
    return this.keyManager.rotate(options)
  }

  /** Get the public JWKS for external verification (e.g., `/.well-known/jwks.json`). */
  async getJwks(): Promise<JSONWebKeySet> {
    return this.keyManager.getJwks()
  }

  /** List tracked tokens, optionally filtered by certificate fingerprint or SAN. */
  async listTokens(filter?: {
    certificateFingerprint?: string
    san?: string
  }): Promise<TokenRecord[]> {
    return this.tokenManager.listTokens(filter)
  }

  /** Get JTIs of all unexpired revoked tokens (for CRL/VRL publishing). */
  async getRevocationList(): Promise<string[]> {
    return this.tokenManager.getRevocationList()
  }

  /** Access the underlying key manager for advanced operations. */
  getKeyManager(): PersistentLocalKeyManager {
    return this.keyManager
  }

  /** Access the underlying token manager for advanced operations. */
  getTokenManager(): LocalTokenManager {
    return this.tokenManager
  }
}
