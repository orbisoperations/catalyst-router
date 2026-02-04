import { z } from 'zod'
import { type VerifyResult } from '../key-manager/index.js'
import { Role, type Entity as CedarEntity } from '../policy/src/types.js'
import { EntityBuilder } from '../policy/src/entity-builder.js'

/**
 * Entity types that can own a token
 */
export const EntityTypeEnum = z.enum(['user', 'service'])
export type EntityType = z.infer<typeof EntityTypeEnum>

/**
 * Standardized roles for the system (Zod schema for validation)
 */
export const RoleEnum = z.nativeEnum(Role)
export type RoleType = z.infer<typeof RoleEnum>

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
  /** Expiration time in milliseconds (unix timestamp * 1000) */
  expiresAt?: number
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
    /** Primary role for principal type mapping (ADR 0007/Cedar) */
    role: Role
    /** The node ID that issued/minted this token */
    nodeId?: string
    /** Set of nodes that are trusted to use this token */
    trustedNodes?: string[]
    /** Set of domains that are trusted to use this token */
    trustedDomains?: string[]
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
  /** List tokens, optionally filtered by certificate fingerprint or SAN */
  listTokens(filter?: { certificateFingerprint?: string; san?: string }): Promise<TokenRecord[]>
  /** Get all unexpired revoked tokens (for CRL/VRL) */
  getRevocationList(): Promise<string[]>
}

/**
 * Helper to convert a JWT payload into a Cedar Entity.
 * Maps the identity to a principal of the primary role type.
 *
 * @example
 * // If role is ADMIN and entity.name is 'alice'
 * // Resulting principal: CATALYST::ADMIN::"alice"
 */
export function jwtToEntity(payload: Record<string, unknown>): CedarEntity {
  const entity = payload.entity as {
    id: string
    name: string
    type: string
    role: Role
    nodeId?: string
    trustedNodes?: string[]
    trustedDomains?: string[]
  }
  const roles = (payload.roles as Role[]) || []
  const primaryRole = entity?.role || roles[0] || Role.USER

  // We use the entity name as the ID in the Cedar principal for better policy readability
  const principalId = entity?.name || entity?.id || (payload.sub as string)

  const builder = new EntityBuilder()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder.entity(`CATALYST::${primaryRole}` as any, principalId)

  if (entity) {
    const attributes: Record<string, unknown> = {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      role: entity.role,
      ...((payload.claims as Record<string, unknown>) || {}),
    }

    // Map 'nodes' and 'domains' from entity OR top-level payload claims to trusted sets
    attributes.trustedNodes = entity.trustedNodes || (payload.nodes as string[]) || []
    attributes.trustedDomains = entity.trustedDomains || (payload.domains as string[]) || []

    builder.setAttributes(attributes)
  }

  // Add other roles as parents if needed, or stick to primary role principal
  // For now, we follow the requested CATALYST::ROLE::"name" model

  const collection = builder.build()
  return collection.getAll()[0]!
}
