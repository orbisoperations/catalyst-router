import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'

import type { IKeyManager } from '../key-manager/types.js'
import { isAuthorizedToRevoke, type RevocationStore } from '../revocation.js'
import { decodeToken, CLOCK_TOLERANCE } from '../jwt.js'
import type { BootstrapService } from '../bootstrap.js'
import {
  SignTokenRequestSchema,
  VerifyTokenRequestSchema,
  RevokeTokenRequestSchema,
  RotateRequestSchema,
  CreateFirstAdminRequestSchema,
  type SignTokenResponse,
  type VerifyTokenResponse,
  type GetPublicKeyResponse,
  type GetJwksResponse,
  type RevokeTokenResponse,
  type RotateResponse,
  type GetCurrentKeyIdResponse,
  type CreateFirstAdminResponse,
  type GetBootstrapStatusResponse,
} from './schema.js'

export class AuthRpcServer extends RpcTarget {
  constructor(
    private keyManager: IKeyManager,
    private revocationStore?: RevocationStore,
    private bootstrapService?: BootstrapService
  ) {
    super()
  }

  /**
   * Sign a JWT with the provided options
   *
   * Note: This endpoint is intended for internal/trusted callers only.
   * Network-level access control should be used to restrict access.
   */
  async signToken(request: unknown): Promise<SignTokenResponse> {
    const parsed = SignTokenRequestSchema.safeParse(request)
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((i) => i.message).join(', ')
      return { success: false, error: errorMessages }
    }

    try {
      const token = await this.keyManager.sign({
        subject: parsed.data.subject,
        audience: parsed.data.audience,
        expiresIn: parsed.data.expiresIn,
        claims: parsed.data.claims,
      })

      return { success: true, token }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token signing failed'
      return { success: false, error: message }
    }
  }

  /**
   * Verify a JWT and return the payload if valid
   */
  async verifyToken(request: unknown): Promise<VerifyTokenResponse> {
    const parsed = VerifyTokenRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { valid: false, error: 'Token verification failed' }
    }

    try {
      const result = await this.keyManager.verify(parsed.data.token, {
        audience: parsed.data.audience,
      })

      if (!result.valid) {
        return { valid: false, error: 'Token verification failed' }
      }

      // Check revocation after cryptographic verification
      if (this.revocationStore && typeof result.payload.jti === 'string') {
        if (this.revocationStore.isRevoked(result.payload.jti)) {
          return { valid: false, error: 'Token revoked' }
        }
      }

      return { valid: true, payload: result.payload }
    } catch {
      return { valid: false, error: 'Token verification failed' }
    }
  }

  /**
   * Revoke a JWT by adding its JTI to the revocation list
   *
   * Authorization: caller must provide authToken proving identity.
   * Revocation allowed if:
   * - authToken.sub matches token.sub (revoking own token), OR
   * - authToken has role: 'admin' claim (admin can revoke any token)
   */
  async revokeToken(request: unknown): Promise<RevokeTokenResponse> {
    if (!this.revocationStore) {
      return { success: false, error: 'Revocation not enabled' }
    }

    const parsed = RevokeTokenRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }

    const { token, authToken } = parsed.data

    // Verify the caller's auth token first
    const authResult = await this.keyManager.verify(authToken)
    if (!authResult.valid) {
      return { success: false, error: 'Invalid auth token' }
    }

    // Just decode target token - no signature verification needed
    // This allows revoking tokens signed with rotated-out keys
    const decoded = decodeToken(token)
    if (!decoded) {
      return { success: false, error: 'Malformed token' }
    }

    const tokenPayload = decoded.payload as Record<string, unknown>

    // Authorization check
    if (!isAuthorizedToRevoke(authResult.payload, tokenPayload)) {
      return { success: false, error: 'Not authorized to revoke this token' }
    }

    const { jti, exp } = tokenPayload

    if (typeof jti !== 'string' || jti === '') {
      return { success: false, error: 'Token missing jti claim' }
    }
    if (typeof exp !== 'number') {
      return { success: false, error: 'Token missing exp claim' }
    }

    // Check if already expired
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (exp + CLOCK_TOLERANCE <= nowSeconds) {
      return { success: false, error: 'Token already expired' }
    }

    this.revocationStore.revoke(jti, new Date(exp * 1000))
    return { success: true }
  }

  /**
   * Get the public key in JWK format (first key from JWKS)
   */
  async getPublicKey(): Promise<GetPublicKeyResponse> {
    try {
      const jwks = await this.keyManager.getJwks()
      if (jwks.keys.length === 0) {
        return { success: false, error: 'No keys available' }
      }
      return { success: true, jwk: jwks.keys[0] as Record<string, unknown> }
    } catch {
      return { success: false, error: 'Failed to get public key' }
    }
  }

  /**
   * Get the JWKS (public keys) for token verification
   */
  async getJwks(): Promise<GetJwksResponse> {
    try {
      const jwks = await this.keyManager.getJwks()
      return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
    } catch {
      return { success: false, error: 'Failed to get JWKS' }
    }
  }

  /**
   * Get the current signing key ID
   */
  async getCurrentKeyId(): Promise<GetCurrentKeyIdResponse> {
    try {
      const kid = await this.keyManager.getCurrentKeyId()
      return { success: true, kid }
    } catch {
      return { success: false, error: 'Failed to get key ID' }
    }
  }

  /**
   * Rotate to a new signing key
   *
   * Authorization: requires authToken with role: 'admin' claim.
   */
  async rotate(request: unknown): Promise<RotateResponse> {
    const parsed = RotateRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }

    // Verify admin authorization
    const authResult = await this.keyManager.verify(parsed.data.authToken)
    if (!authResult.valid) {
      return { success: false, error: 'Invalid auth token' }
    }
    if (authResult.payload.role !== 'admin') {
      return { success: false, error: 'Admin authorization required' }
    }

    try {
      const result = await this.keyManager.rotate({
        immediate: parsed.data.immediate,
        gracePeriodMs: parsed.data.gracePeriodMs,
      })

      return {
        success: true,
        previousKeyId: result.previousKeyId,
        newKeyId: result.newKeyId,
        gracePeriodEndsAt: result.gracePeriodEndsAt?.toISOString(),
      }
    } catch {
      return { success: false, error: 'Rotation failed' }
    }
  }

  /**
   * Create the first admin user using a bootstrap token
   *
   * This is an unauthenticated endpoint that can only be used once.
   * The bootstrap token must have been generated during service initialization.
   * Returns a JWT on success for immediate use.
   */
  async createFirstAdmin(request: unknown): Promise<CreateFirstAdminResponse> {
    if (!this.bootstrapService) {
      return { success: false, error: 'Bootstrap not configured' }
    }

    const parsed = CreateFirstAdminRequestSchema.safeParse(request)
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((i) => i.message).join(', ')
      return { success: false, error: errorMessages }
    }

    const result = await this.bootstrapService.createFirstAdmin(parsed.data)

    if (!result.success) {
      return { success: false, error: result.error ?? 'Bootstrap failed' }
    }

    // Issue JWT for the newly created admin
    const token = await this.keyManager.sign({
      subject: result.userId!,
      expiresIn: '1h',
      claims: {
        roles: ['admin'],
        orgId: 'default',
      },
    })

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    return {
      success: true,
      userId: result.userId!,
      token,
      expiresAt: expiresAt.toISOString(),
    }
  }

  /**
   * Get bootstrap status (initialized/used)
   *
   * This is an unauthenticated endpoint that reveals no sensitive information.
   */
  async getBootstrapStatus(): Promise<GetBootstrapStatusResponse> {
    if (!this.bootstrapService) {
      return { initialized: false, used: false }
    }

    return this.bootstrapService.getBootstrapStatus()
  }
}

export function createAuthRpcHandler(rpcServer: AuthRpcServer): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })
  return app
}
