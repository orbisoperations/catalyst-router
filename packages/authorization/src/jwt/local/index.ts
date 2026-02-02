import * as jose from 'jose'
import type {
    TokenManager,
    TokenStore,
    MintOptions,
    TokenRecord,
    EntityType,
} from '../index.js'
import type { IKeyManager, VerifyResult } from '../../key-manager/index.ts'

export class LocalTokenManager implements TokenManager {
    constructor(
        private keyManager: IKeyManager,
        private store: TokenStore
    ) { }

    async mint(options: MintOptions): Promise<string> {
        const claims = { ...options.claims }

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
            entityId: options.entity.id,
            entityName: options.entity.name,
            entityType: options.entity.type,
        }

        await this.store.recordToken(record)

        return token
    }

    async verify(token: string, options?: { audience?: string | string[] }): Promise<VerifyResult> {
        const result = await this.keyManager.verify(token, options)
        if (!result.valid) return result

        const jti = result.payload.jti as string
        if (!jti) {
            return { valid: false, error: 'Token missing jti' }
        }

        // Check tracking store
        const record = await this.store.findToken(jti)
        if (!record) {
            return { valid: false, error: 'Token not found in tracking store' }
        }

        // Check expiration (optional redundancy)
        const now = Math.floor(Date.now() / 1000)
        if (record.expiry < now) {
            return { valid: false, error: 'Token expired' }
        }

        // In a real mTLS scenario, the caller would pass the fingerprint from the cert
        // and we would compare it here against result.payload.cnf['x5t#S256']
        // For this refactor, we are ensuring the persistence and tracking works.

        return result
    }
}
