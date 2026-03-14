import { getLogger } from '@catalyst/telemetry'
import * as jose from 'jose'
import type { TokenManager, TokenStore, MintOptions, TokenRecord } from '../index.js'
import type { IKeyManager, VerifyResult } from '../../key-manager/index.ts'

const logger = getLogger(['catalyst', 'auth', 'token'])

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

    logger.info(
      'Token minted: jti={token.jti} subject={token.subject} principal={token.principal}',
      {
        'event.name': 'auth.token.minted',
        'token.jti': decoded.jti,
        'token.subject': options.subject,
        'token.principal': options.principal,
        'token.entity_type': options.entity.type,
        'token.expires_at': new Date(decoded.exp * 1000).toISOString(),
      }
    )

    return token
  }

  async revoke(options: { jti?: string; san?: string }): Promise<void> {
    if (options.jti) {
      await this.store.revokeToken(options.jti)
      logger.info('Token revoked by JTI: {token.jti}', {
        'event.name': 'auth.token.revoked',
        'token.jti': options.jti,
        'revoke.method': 'jti',
      })
    }
    if (options.san) {
      await this.store.revokeBySan(options.san)
      logger.info('Tokens revoked by SAN: {token.san}', {
        'event.name': 'auth.token.revoked',
        'token.san': options.san,
        'revoke.method': 'san',
      })
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
      logger.warn('Token rejected (revoked): jti={token.jti}', {
        'event.name': 'auth.token.rejected',
        'token.jti': jti,
        reason: 'revoked',
      })
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
