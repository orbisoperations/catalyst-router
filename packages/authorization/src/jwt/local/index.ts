import * as jose from 'jose'
import type { TokenManager, TokenStore, MintOptions, TokenRecord } from '../index.js'
import type { IKeyManager, VerifyResult } from '../../key-manager/index.ts'

export class LocalTokenManager implements TokenManager {
  constructor(
    private keyManager: IKeyManager,
    private store: TokenStore
  ) {}

  getStore(): TokenStore {
    return this.store
  }

  async mint(options: MintOptions): Promise<string> {
    const claims: Record<string, unknown> = {
      ...options.claims,
      entity: options.entity,
      roles: options.roles,
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
      expiresIn: options.expiresIn,
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
}
