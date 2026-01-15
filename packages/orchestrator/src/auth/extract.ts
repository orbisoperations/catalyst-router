import type { AuthContext } from '../plugins/types.js'
import type { IAuthClient } from '../clients/auth.js'

/**
 * Result of token verification and auth extraction.
 */
export interface AuthExtractionResult {
  auth: AuthContext
  /** Token expiry time from JWT exp claim */
  expiresAt: Date | null
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(headers: Headers): string | null {
  const authHeader = headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return null
}

/**
 * Verify token and extract auth context using the auth service.
 * Returns null if token is missing or invalid.
 */
export async function verifyAndExtractAuth(
  headers: Headers,
  authClient: IAuthClient,
  audience?: string
): Promise<AuthExtractionResult | null> {
  const token = extractBearerToken(headers)

  if (!token) {
    return null
  }

  const result = await authClient.verifyToken(token, audience)

  if (!result.valid || !result.payload) {
    return null
  }

  try {
    return extractAuthFromPayload(result.payload)
  } catch (err) {
    console.warn('[Auth] Failed to extract auth context:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Extract AuthContext and expiry from JWT payload.
 * Maps standard JWT claims to internal auth context.
 */
export function extractAuthFromPayload(payload: Record<string, unknown>): AuthExtractionResult {
  const auth: AuthContext = {}

  // User ID from subject claim
  if (typeof payload.sub === 'string') {
    auth.userId = payload.sub
  }

  // Organization ID (custom claim)
  if (typeof payload.orgId === 'string') {
    auth.orgId = payload.orgId
  }

  // Roles - handle both single role and array of roles
  if (Array.isArray(payload.roles)) {
    if (!payload.roles.every((r): r is string => typeof r === 'string')) {
      throw new Error('Malformed roles claim: all roles must be strings')
    }
    auth.roles = payload.roles
  } else if (typeof payload.role === 'string') {
    auth.roles = [payload.role]
  }

  // Extract expiry from standard JWT exp claim (Unix timestamp in seconds)
  let expiresAt: Date | null = null
  if (typeof payload.exp === 'number') {
    expiresAt = new Date(payload.exp * 1000)
  }

  return { auth, expiresAt }
}
