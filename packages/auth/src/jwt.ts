import * as jose from 'jose'
import { z } from 'zod'
import { ALGORITHM, type KeyPair } from './keys.js'

// Default token expiration (1 hour)
const DEFAULT_EXPIRATION = '1h'

// Maximum allowed token lifetime (52 weeks in seconds)
const MAX_LIFETIME_SECONDS = 52 * 7 * 24 * 60 * 60

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
  expiresIn: z.string().optional(), // e.g., '1h', '7d', '30m'
  claims: z.record(z.string(), z.unknown()).optional(),
})

export type SignOptions = z.infer<typeof SignOptionsSchema>

import type { VerifyResult } from '@catalyst/authorization'
export type { VerifyResult }

/**
 * Parse a duration string (e.g., '1h', '7d', '30m') to seconds
 * Returns null if the format is invalid
 */
function parseDurationToSeconds(duration: string): number | null {
  const match = duration.match(/^(\d+)([smhd])$/)
  if (!match) return null

  const value = parseInt(match[1], 10)
  const unit = match[2]

  switch (unit) {
    case 's':
      return value
    case 'm':
      return value * 60
    case 'h':
      return value * 60 * 60
    case 'd':
      return value * 24 * 60 * 60
    default:
      return null
  }
}

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

  // Validate and enforce maximum token lifetime
  const expiresIn = validated.expiresIn ?? DEFAULT_EXPIRATION
  const lifetimeSeconds = parseDurationToSeconds(expiresIn)
  if (lifetimeSeconds === null) {
    throw new Error(`Invalid expiration format: ${expiresIn}. Use format like '1h', '30m', '7d'`)
  }
  if (lifetimeSeconds > MAX_LIFETIME_SECONDS) {
    throw new Error(`Token lifetime ${expiresIn} exceeds maximum allowed (52 weeks)`)
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

  builder.setExpirationTime(expiresIn)

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
