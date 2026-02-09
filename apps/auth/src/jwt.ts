import * as jose from 'jose'
import { z } from 'zod'
import { ALGORITHM, type KeyPair } from './keys.js'

// Default token expiration (1 hour) in milliseconds
const DEFAULT_EXPIRATION_MS = 60 * 60 * 1000

// Maximum allowed token lifetime (52 weeks in milliseconds)
const MAX_LIFETIME_MS = 52 * 7 * 24 * 60 * 60 * 1000

// Default issuer
const DEFAULT_ISSUER = process.env.CATALYST_AUTH_ISSUER || 'catalyst-auth'

// Clock tolerance for verification (seconds) - handles distributed system clock skew
export const CLOCK_TOLERANCE = 30

// Reserved JWT claims that cannot be overridden via custom claims
const RESERVED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'] as const

/**
 * Options for signing a JWT
 */
export const SignOptionsSchema = z.object({
  subject: z.string(),
  audience: z.string().or(z.array(z.string())).optional(),
  expiresAt: z.number().int().positive().optional(), // Unix timestamp in ms
  claims: z.record(z.string(), z.unknown()).optional(),
})

export type SignOptions = z.infer<typeof SignOptionsSchema>

import type { VerifyResult } from '@catalyst/authorization'
export type { VerifyResult }

/**
 * Generate a unique token ID (jti) for replay protection
 */
function generateJti(): string {
  return crypto.randomUUID()
}

/**
 * Sign a JWT with the given options
 */
export async function signToken(keyPair: KeyPair, options: SignOptions): Promise<string> {
  // Validate input
  const validated = SignOptionsSchema.parse(options)

  const now = Date.now()
  const expiresAt = validated.expiresAt ?? now + DEFAULT_EXPIRATION_MS

  // Validate expiration is in the future
  if (expiresAt <= now) {
    throw new Error(`Expiration time ${expiresAt} must be in the future (now: ${now})`)
  }

  // Validate max lifetime
  if (expiresAt - now > MAX_LIFETIME_MS) {
    throw new Error(`Token lifetime exceeds maximum allowed (52 weeks)`)
  }

  // Strip reserved claims to prevent override of standard JWT claims
  const claims: Record<string, unknown> = { ...validated.claims }
  for (const reserved of RESERVED_CLAIMS) {
    delete claims[reserved]
  }

  const builder = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM, kid: keyPair.kid })
    .setIssuedAt()
    .setIssuer(DEFAULT_ISSUER)
    .setSubject(validated.subject)
    .setJti(generateJti())

  if (validated.audience) {
    builder.setAudience(validated.audience)
  }

  // jose expects seconds for numeric input
  builder.setExpirationTime(Math.floor(expiresAt / 1000))

  return builder.sign(keyPair.privateKey)
}

/**
 * Options for verifying a JWT
 */
export interface VerifyOptions {
  /** Expected audience - if provided, token must have matching aud claim */
  audience?: string | string[]
}

/**
 * Verify a JWT and return the payload if valid
 */
export async function verifyToken(
  keyPair: KeyPair,
  token: string,
  options?: VerifyOptions
): Promise<VerifyResult> {
  try {
    const { payload } = await jose.jwtVerify(token, keyPair.publicKey, {
      issuer: DEFAULT_ISSUER,
      algorithms: [ALGORITHM],
      clockTolerance: CLOCK_TOLERANCE,
      audience: options?.audience,
    })

    return {
      valid: true,
      payload: payload as Record<string, unknown>,
    }
  } catch (error) {
    // Return generic error to avoid leaking information to attackers
    // Specific error types logged server-side if needed
    if (error instanceof jose.errors.JWTExpired) {
      return { valid: false, error: 'Token expired' }
    }
    return { valid: false, error: 'Invalid token' }
  }
}

/**
 * Decode a JWT without verification (for inspection only)
 * Uses jose's platform-agnostic decode functions
 */
export function decodeToken(token: string): {
  header: jose.ProtectedHeaderParameters
  payload: jose.JWTPayload
} | null {
  try {
    return {
      header: jose.decodeProtectedHeader(token),
      payload: jose.decodeJwt(token),
    }
  } catch {
    return null
  }
}
