import { z } from 'zod'
import { type IKeyManager, type VerifyResult } from '../key-manager/index.js'

/**
 * Entity types that can own a token
 */
export const EntityTypeEnum = z.enum(['user', 'service'])
export type EntityType = z.infer<typeof EntityTypeEnum>

/**
 * Record of a minted token for tracking
 */
export interface TokenRecord {
    jti: string
    expiry: number
    cfn?: string // SHA-256 thumbprint for certificate-bound tokens
    entityId: string
    entityName: string
    entityType: EntityType
}

/**
 * Options for minting a new token
 */
export interface MintOptions {
    subject: string
    audience?: string | string[]
    expiresIn?: string
    claims?: Record<string, unknown>
    /** Certificate fingerprint for binding (ADR 0007) */
    certificateFingerprint?: string
    /** Information about the entity using the token */
    entity: {
        id: string
        name: string
        type: EntityType
    }
}

/**
 * TokenStore interface for persistence of token metadata
 */
export interface TokenStore {
    /** Record a newly minted token */
    recordToken(record: TokenRecord): Promise<void>
    /** Find a token by its JTI (JWT ID) */
    findToken(jti: string): Promise<TokenRecord | null>
    /** Revoke a token (or check for revocation) - can be extended later */
    isRevoked(jti: string): Promise<boolean>
}

/**
 * TokenManager interface for high-level token lifecycle management
 */
export interface TokenManager {
    /** Mint a new token and track it */
    mint(options: MintOptions): Promise<string>
    /** Verify a token and check its tracking status */
    verify(token: string, options?: { audience?: string | string[] }): Promise<VerifyResult>
}
