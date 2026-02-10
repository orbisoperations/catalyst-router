import type { TokenRecord } from '../../jwt/index.js'
import { Principal } from '../../policy/src/definitions/models.js'
import { z } from 'zod'

export const PrincipalSchema = z.enum(Principal)

/**
 * SignToken Request/Response schemas
 *
 * Note: This endpoint is intended for internal/trusted callers only.
 * Network-level access control should be used to restrict access.
 */
export const SignTokenRequestSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  audience: z.union([z.string(), z.array(z.string())]).optional(),
  expiresIn: z.string().optional(), // e.g., '1h', '7d', '30m'
  claims: z.record(z.string(), z.unknown()).optional(),
})

export type SignTokenRequest = z.infer<typeof SignTokenRequestSchema>

export const SignTokenResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    token: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type SignTokenResponse = z.infer<typeof SignTokenResponseSchema>

/**
 * VerifyToken Request/Response schemas
 */
export const VerifyTokenRequestSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  audience: z.string().optional(),
})

export type VerifyTokenRequest = z.infer<typeof VerifyTokenRequestSchema>

export const VerifyTokenResponseSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    valid: z.literal(false),
    error: z.string(),
  }),
])

export type VerifyTokenResponse = z.infer<typeof VerifyTokenResponseSchema>

/**
 * GetPublicKey Response schema
 */
export const GetPublicKeyResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), jwk: z.record(z.string(), z.unknown()) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type GetPublicKeyResponse = z.infer<typeof GetPublicKeyResponseSchema>

/**
 * GetJwks Response schema
 */
export const GetJwksResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type GetJwksResponse = z.infer<typeof GetJwksResponseSchema>

/**
 * RevokeToken Request/Response schemas
 *
 * Authorization: caller must provide authToken proving identity.
 * Revocation allowed if:
 * - authToken.sub matches token.sub (revoking own token), OR
 * - authToken has role: 'admin' claim (admin can revoke any token)
 */
export const RevokeTokenRequestSchema = z.object({
  /** Token to revoke */
  token: z.string().min(1, 'Token is required'),
  /** Caller's auth token for authorization */
  authToken: z.string().min(1, 'Auth token is required'),
})

export type RevokeTokenRequest = z.infer<typeof RevokeTokenRequestSchema>

export const RevokeTokenResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type RevokeTokenResponse = z.infer<typeof RevokeTokenResponseSchema>

/**
 * Rotate Request/Response schemas
 *
 * Authorization: caller must provide authToken with role: 'admin' claim.
 * Only admins can rotate keys.
 */
export const RotateRequestSchema = z.object({
  /** Admin auth token for authorization */
  authToken: z.string().min(1, 'Auth token is required'),
  /** Skip grace period, invalidate old key immediately */
  immediate: z.boolean().optional().default(false),
  /** Custom grace period in milliseconds (default: 24 hours) */
  gracePeriodMs: z.number().positive().optional(),
})

export type RotateRequest = z.infer<typeof RotateRequestSchema>

export const RotateResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    previousKeyId: z.string(),
    newKeyId: z.string(),
    gracePeriodEndsAt: z.string().optional(), // ISO date string
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type RotateResponse = z.infer<typeof RotateResponseSchema>

/**
 * GetCurrentKeyId Response schema
 */
export const GetCurrentKeyIdResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), kid: z.string() }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type GetCurrentKeyIdResponse = z.infer<typeof GetCurrentKeyIdResponseSchema>

/**
 * progressive API handler interfaces
 */
export interface TokenHandlers {
  /** Create a new token with optional SANs and entity info */
  create(request: {
    subject: string
    entity: {
      id: string
      name: string
      type: 'user' | 'service'
      nodeId?: string
    }
    principal: z.infer<typeof PrincipalSchema>
    sans?: string[]
    expiresIn?: string
  }): Promise<string>
  /** Revoke a token by JTI or SAN */
  revoke(request: { jti?: string; san?: string }): Promise<void>
  /** List tokens with optional filters */
  list(request: { certificateFingerprint?: string; san?: string }): Promise<TokenRecord[]>
}

export interface CertHandlers {
  /** List all active public keys/certs */
  list(): Promise<GetJwksResponse>
  /** Rotate to a new signing key */
  rotate(request?: { immediate?: boolean; gracePeriodMs?: number }): Promise<RotateResponse>
  /** List all tokens minted against a specific certificate */
  getTokensByCert(request: { fingerprint: string }): Promise<TokenRecord[]>
}

export interface ValidationHandlers {
  /** Core JWT validation */
  validate(request: { token: string; audience?: string }): Promise<VerifyTokenResponse>
  /** Get full revocation list (JTIs of all unexpired revoked tokens) */
  getRevocationList(): Promise<string[]>
  /** Public JWKS endpoint */
  getJWKS(): Promise<GetJwksResponse>
}

/**
 * PublicAPI (AuthRpcServer) schemas
 */
export const TokenApiRequestSchema = z.string() // token
export const CertApiRequestSchema = z.string() // token
export const ValidationApiRequestSchema = z.string() // token

export const CreateTokenRequestSchema = z.object({
  role: z.string(),
  name: z.string().min(1),
})

export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>

/**
 * Permissions API schemas
 */
export const PermissionsApiRequestSchema = z.string() // token

export const NodeContextSchema = z.object({
  nodeId: z.string(),
  domains: z.array(z.string()),
})

export type NodeContext = z.infer<typeof NodeContextSchema>

export const AuthorizeActionRequestSchema = z.object({
  action: z.string(),
  nodeContext: NodeContextSchema,
})

export type AuthorizeActionRequest = z.infer<typeof AuthorizeActionRequestSchema>

/**
 * Authorization result with discriminated union for different error types
 */
export const AuthorizeActionResultSchema = z.discriminatedUnion('success', [
  // Success case
  z.object({
    success: z.literal(true),
    allowed: z.boolean(),
  }),
  // Token expired
  z.object({
    success: z.literal(false),
    errorType: z.literal('token_expired'),
    reason: z.string(),
  }),
  // Token malformed
  z.object({
    success: z.literal(false),
    errorType: z.literal('token_malformed'),
    reason: z.string(),
  }),
  // Token revoked
  z.object({
    success: z.literal(false),
    errorType: z.literal('token_revoked'),
    reason: z.string(),
  }),
  // Permission denied
  z.object({
    success: z.literal(false),
    errorType: z.literal('permission_denied'),
    reasons: z.array(z.string()),
  }),
  // System error
  z.object({
    success: z.literal(false),
    errorType: z.literal('system_error'),
    reason: z.string(),
  }),
])

export type AuthorizeActionResult = z.infer<typeof AuthorizeActionResultSchema>

/**
 * Permissions handlers interface
 */
export interface PermissionsHandlers {
  /** Authorize an action based on token and node context */
  authorizeAction(request: AuthorizeActionRequest): Promise<AuthorizeActionResult>
}
