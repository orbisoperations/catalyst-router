import * as jose from 'jose'
import type { TokenManager, TokenStore, MintOptions, TokenRecord } from '../index.js'
import type { IKeyManager, VerifyResult } from '../../key-manager/index.ts'

export class LocalTokenManager implements TokenManager {
  constructor(
    private keyManager: IKeyManager,
    private store: TokenStore,
    private nodeId?: string
  ) {}

  getStore(): TokenStore {
    return this.store
  }

  async mint(options: MintOptions): Promise<string> {
    // Auto-inject nodeId if configured and not already present
    if (this.nodeId && !options.entity.nodeId) {
      options.entity.nodeId = this.nodeId
    }

    const claims: Record<string, unknown> = {
      ...options.claims,
      entity: options.entity,
      principal: options.principal,
    }

    // Support certificate binding (ADR 0007)
    if (options.certificateFingerprint) {
      claims.cnf = {
        'x5t#S256': options.certificateFingerprint,
      }
    }

    const token = await this.keyManager.sign({
      subject: options.subject,
      audience: options.audience,
      expiresAt: options.expiresAt,
      claims,
    })

    const decoded = jose.decodeJwt(token)
    if (!decoded.jti || !decoded.exp) {
      throw new Error('Minted token missing required claims (jti, exp)')
    }

    const record: TokenRecord = {
      jti: decoded.jti,
      expiry: decoded.exp,
      cfn: options.certificateFingerprint,
      sans: options.sans ?? [],
      entityId: options.entity.id,
      entityName: options.entity.name,
      entityType: options.entity.type,
      revoked: false,
    }

    await this.store.recordToken(record)

    return token
  }

  async revoke(options: { jti?: string; san?: string }): Promise<void> {
    if (options.jti) {
      await this.store.revokeToken(options.jti)
    }
    if (options.san) {
      await this.store.revokeBySan(options.san)
    }
  }

  async verify(token: string, options?: { audience?: string | string[] }): Promise<VerifyResult> {
    const result = await this.keyManager.verify(token, options)
    if (!result.valid) return result

    const jti = result.payload.jti as string
    if (!jti) {
      return { valid: false, error: 'Token missing jti' }
    }

    // Check if token is revoked in the store
    const isRevoked = await this.store.isRevoked(jti)
    if (isRevoked) {
      return { valid: false, error: 'Token is revoked' }
    }

    return result
  }

  async listTokens(filter?: {
    certificateFingerprint?: string
    san?: string
  }): Promise<TokenRecord[]> {
    return this.store.listTokens(filter)
  }

  async getRevocationList(): Promise<string[]> {
    return this.store.getRevocationList()
  }
}
