import { z } from 'zod'
import { Role } from '../permissions.js'

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
 * CreateFirstAdmin Request/Response schemas
 *
 * Bootstrap flow: creates the first admin user using a one-time bootstrap token.
 * The token is generated on first deployment and must be provided to create the admin.
 */
export const CreateFirstAdminRequestSchema = z.object({
  /** One-time bootstrap token */
  token: z.string().min(1, 'Bootstrap token is required'),
  /** Admin email address */
  email: z.string().email('Valid email is required'),
  /** Admin password (will be hashed with Argon2id) */
  password: z.string().min(12, 'Password must be at least 12 characters'),
})

export type CreateFirstAdminRequest = z.infer<typeof CreateFirstAdminRequestSchema>

export const CreateFirstAdminResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    userId: z.string(),
    token: z.string(),
    expiresAt: z.string(), // ISO date string
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type CreateFirstAdminResponse = z.infer<typeof CreateFirstAdminResponseSchema>

/**
 * GetBootstrapStatus Response schema
 *
 * Returns whether bootstrap has been initialized and/or used.
 * Does not reveal the token itself.
 */
export const GetBootstrapStatusResponseSchema = z.object({
  initialized: z.boolean(),
  used: z.boolean(),
})

export type GetBootstrapStatusResponse = z.infer<typeof GetBootstrapStatusResponseSchema>

/**
 * Login Request/Response schemas
 *
 * Authenticates a user with email/password and returns a JWT.
 */
export const LoginRequestSchema = z.object({
  /** User email address */
  email: z.string().email('Valid email is required'),
  /** User password */
  password: z.string().min(1, 'Password is required'),
})

export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const LoginResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    token: z.string(),
    expiresAt: z.string(), // ISO date string
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type LoginResponse = z.infer<typeof LoginResponseSchema>

/**
 * CreateServiceAccount Request/Response schemas
 */
export const CreateServiceAccountRequestSchema = z.object({
  /** Service account name (unique per org) */
  name: z.string().min(1).max(100),
  /** Roles to assign */
  roles: z.array(z.string()),
  /** Organization ID */
  orgId: z.string().default('default'),
  /** Expiry in days (max 365) */
  expiresInDays: z.number().int().min(1).max(365),
  /** Auth token of the creator (must be admin) */
  authToken: z.string().min(1),
})

export type CreateServiceAccountRequest = z.infer<typeof CreateServiceAccountRequestSchema>

export const CreateServiceAccountResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    serviceAccountId: z.string(),
    apiKey: z.string(),
    expiresAt: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type CreateServiceAccountResponse = z.infer<typeof CreateServiceAccountResponseSchema>

/**
 * ListServiceAccounts Request/Response schemas
 */
export const ListServiceAccountsRequestSchema = z.object({
  orgId: z.string().default('default'),
  authToken: z.string().min(1),
})

export type ListServiceAccountsRequest = z.infer<typeof ListServiceAccountsRequestSchema>

export const ListServiceAccountsResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        roles: z.array(z.string()),
        keyPrefix: z.string(),
        expiresAt: z.string(),
        createdAt: z.string(),
      })
    ),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type ListServiceAccountsResponse = z.infer<typeof ListServiceAccountsResponseSchema>

/**
 * DeleteServiceAccount Request/Response schemas
 */
export const DeleteServiceAccountRequestSchema = z.object({
  serviceAccountId: z.string().min(1),
  authToken: z.string().min(1),
})

export type DeleteServiceAccountRequest = z.infer<typeof DeleteServiceAccountRequestSchema>

export const DeleteServiceAccountResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type DeleteServiceAccountResponse = z.infer<typeof DeleteServiceAccountResponseSchema>

/**
 * AuthenticateApiKey Request/Response schemas
 */
export const AuthenticateApiKeyRequestSchema = z.object({
  apiKey: z.string().min(1),
})

export type AuthenticateApiKeyRequest = z.infer<typeof AuthenticateApiKeyRequestSchema>

export const AuthenticateApiKeyResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    auth: z.object({
      userId: z.string(),
      roles: z.array(z.string()),
      orgId: z.string(),
    }),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
])

export type AuthenticateApiKeyResponse = z.infer<typeof AuthenticateApiKeyResponseSchema>
/**
 * progressive API handler interfaces
 */
export interface AdminHandlers {
  createToken(request: { role: Role; name: string }): Promise<string>
  revokeToken(request: { target: string }): Promise<void>
}

export interface ValidationHandlers {
  getJWKS(): Promise<GetJwksResponse>
  getRevocationList(): Promise<string[]>
  validate(request: { token: string }): Promise<VerifyTokenResponse>
}

/**
 * PublicAPI (AuthRpcServer) schemas
 */
export const AdminApiRequestSchema = z.string() // token
export const ValidationApiRequestSchema = z.string() // token

export const CreateTokenRequestSchema = z.object({
  role: z.string(),
  name: z.string().min(1),
})

export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>
