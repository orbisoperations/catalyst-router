import { z } from 'zod'
import { type IKeyManager, type VerifyResult } from '../key-manager/index.js'

/**
 * Entity types that can own a token
 */
export const EntityTypeEnum = z.enum(['user', 'service'])
export type EntityType = z.infer<typeof EntityTypeEnum>

/**
 * Standardized roles for the system
 */
export const RoleEnum = z.enum([
    'ADMIN',
    'NODE',
    'NODE_CUSTODIAN',
    'DATA_CUSTODIAN',
    'USER',
])
export type Role = z.infer<typeof RoleEnum>

/**
 * Record of a minted token for tracking
 */
export interface TokenRecord {
    jti: string
    expiry: number
    cfn?: string // SHA-256 thumbprint for certificate-bound tokens
    sans: string[] // Subject Alternative Names
    entityId: string
    entityName: string
    entityType: EntityType
    revoked: boolean
}

/**
 * Options for minting a new token
 */
export interface MintOptions {
    subject: string
    audience?: string | string[]
    expiresIn?: string
    claims?: Record<string, unknown>
    /** Roles assigned to the token (mandatory) */
    roles: Role[]
    /** Certificate fingerprint for binding (ADR 0007) */
    certificateFingerprint?: string
    /** Subject Alternative Names for the token */
    sans?: string[]
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
    /** Revoke a token by JTI */
    revokeToken(jti: string): Promise<void>
    /** Revoke all tokens associated with a SAN */
    revokeBySan(san: string): Promise<void>
    /** Check if a token is revoked */
    isRevoked(jti: string): Promise<boolean>
    /** Get all unexpired revoked tokens (for CRL/VRL) */
    getRevocationList(): Promise<string[]>
    /** List tokens, optionally filtered by cert fingerprint or SAN */
    listTokens(filter?: { certificateFingerprint?: string; san?: string }): Promise<TokenRecord[]>
}

/**
 * TokenManager interface for high-level token lifecycle management
 */
export interface TokenManager {
    /** Mint a new token and track it */
    mint(options: MintOptions): Promise<string>
    /** Revoke a token by JTI or SAN */
    revoke(options: { jti?: string; san?: string }): Promise<void>
    /** Verify a token and check its tracking status */
    verify(token: string, options?: { audience?: string | string[] }): Promise<VerifyResult>
}
