import { z } from 'zod'

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
  z.object({ success: z.literal(true), jwk: z.record(z.unknown()) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type GetPublicKeyResponse = z.infer<typeof GetPublicKeyResponseSchema>

/**
 * GetJwks Response schema
 */
export const GetJwksResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), jwks: z.object({ keys: z.array(z.record(z.unknown())) }) }),
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
