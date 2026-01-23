import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'

import type { IKeyManager } from '../key-manager/types.js'
import { isAuthorizedToRevoke, type RevocationStore } from '../revocation.js'
import { decodeToken, CLOCK_TOLERANCE } from '../jwt.js'
import type { BootstrapService } from '../bootstrap.js'
import type { LoginService } from '../login.js'
import type { ApiKeyService } from '../api-key-service.js'
import {
  SignTokenRequestSchema,
  VerifyTokenRequestSchema,
  RevokeTokenRequestSchema,
  RotateRequestSchema,
  CreateFirstAdminRequestSchema,
  LoginRequestSchema,
  CreateServiceAccountRequestSchema,
  ListServiceAccountsRequestSchema,
  DeleteServiceAccountRequestSchema,
  AuthenticateApiKeyRequestSchema,
  type SignTokenResponse,
  type VerifyTokenResponse,
  type GetPublicKeyResponse,
  type GetJwksResponse,
  type RevokeTokenResponse,
  type RotateResponse,
  type GetCurrentKeyIdResponse,
  type CreateFirstAdminResponse,
  type GetBootstrapStatusResponse,
  type LoginResponse,
  type CreateServiceAccountResponse,
  type ListServiceAccountsResponse,
  type DeleteServiceAccountResponse,
  type AuthenticateApiKeyResponse,
} from './schema.js'

export class AuthRpcServer extends RpcTarget {
  constructor(
    private keyManager: IKeyManager,
    private revocationStore?: RevocationStore,
    private bootstrapService?: BootstrapService,
    private loginService?: LoginService,
    private apiKeyService?: ApiKeyService
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

  /**
   * Authenticate user with email/password and return JWT
   *
   * This is an unauthenticated endpoint.
   * Returns the same error for wrong password and unknown email (timing-safe).
   */
  async login(request: unknown): Promise<LoginResponse> {
    if (!this.loginService) {
      return { success: false, error: 'Login not configured' }
    }

    const parsed = LoginRequestSchema.safeParse(request)
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((i) => i.message).join(', ')
      return { success: false, error: errorMessages }
    }

    const result = await this.loginService.login(parsed.data)

    if (!result.success) {
      return { success: false, error: result.error ?? 'Login failed' }
    }

    return {
      success: true,
      token: result.token!,
      expiresAt: result.expiresAt!.toISOString(),
    }
  }

  /**
   * Create a service account with API key
   *
   * Requires admin authorization.
   */
  async createServiceAccount(request: unknown): Promise<CreateServiceAccountResponse> {
    if (!this.apiKeyService) {
      return { success: false, error: 'API key service not configured' }
    }

    const parsed = CreateServiceAccountRequestSchema.safeParse(request)
    if (!parsed.success) {
      const errorMessages = parsed.error.issues.map((i) => i.message).join(', ')
      return { success: false, error: errorMessages }
    }

    // Verify admin authorization
    const authResult = await this.keyManager.verify(parsed.data.authToken)
    if (!authResult.valid) {
      return { success: false, error: 'Invalid auth token' }
    }
    const roles = authResult.payload.roles as string[] | undefined
    if (!roles?.includes('admin')) {
      return { success: false, error: 'Admin authorization required' }
    }

    const result = await this.apiKeyService.createServiceAccount({
      name: parsed.data.name,
      roles: parsed.data.roles,
      orgId: parsed.data.orgId,
      expiresInDays: parsed.data.expiresInDays,
      createdBy: authResult.payload.sub as string,
    })

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to create service account' }
    }

    return {
      success: true,
      serviceAccountId: result.serviceAccountId!,
      apiKey: result.apiKey!,
      expiresAt: result.expiresAt!.toISOString(),
    }
  }

  /**
   * List service accounts for an org
   *
   * Requires admin authorization.
   */
  async listServiceAccounts(request: unknown): Promise<ListServiceAccountsResponse> {
    if (!this.apiKeyService) {
      return { success: false, error: 'API key service not configured' }
    }

    const parsed = ListServiceAccountsRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }

    // Verify admin authorization
    const authResult = await this.keyManager.verify(parsed.data.authToken)
    if (!authResult.valid) {
      return { success: false, error: 'Invalid auth token' }
    }
    const roles = authResult.payload.roles as string[] | undefined
    if (!roles?.includes('admin')) {
      return { success: false, error: 'Admin authorization required' }
    }

    const accounts = await this.apiKeyService.listServiceAccounts(parsed.data.orgId)

    return {
      success: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        roles: a.roles,
        keyPrefix: a.keyPrefix,
        expiresAt: a.expiresAt.toISOString(),
        createdAt: a.createdAt.toISOString(),
      })),
    }
  }

  /**
   * Delete a service account
   *
   * Requires admin authorization.
   */
  async deleteServiceAccount(request: unknown): Promise<DeleteServiceAccountResponse> {
    if (!this.apiKeyService) {
      return { success: false, error: 'API key service not configured' }
    }

    const parsed = DeleteServiceAccountRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }

    // Verify admin authorization
    const authResult = await this.keyManager.verify(parsed.data.authToken)
    if (!authResult.valid) {
      return { success: false, error: 'Invalid auth token' }
    }
    const roles = authResult.payload.roles as string[] | undefined
    if (!roles?.includes('admin')) {
      return { success: false, error: 'Admin authorization required' }
    }

    await this.apiKeyService.deleteServiceAccount(parsed.data.serviceAccountId)
    return { success: true }
  }

  /**
   * Authenticate an API key
   *
   * This is an unauthenticated endpoint used by the orchestrator
   * to validate API keys from incoming requests.
   */
  async authenticateApiKey(request: unknown): Promise<AuthenticateApiKeyResponse> {
    if (!this.apiKeyService) {
      return { success: false, error: 'API key service not configured' }
    }

    const parsed = AuthenticateApiKeyRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }

    return this.apiKeyService.authenticateApiKey(parsed.data.apiKey)
  }
}

export function createAuthRpcHandler(rpcServer: AuthRpcServer): Hono {
  const app = new Hono()

  // Simple JSON-RPC handler for HTTP POST (curl-friendly)
  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const { method, params } = body as { method: string; params: unknown }

      if (!method) {
        return c.json({ success: false, error: 'Method required' }, 400)
      }

      // Route to appropriate method
      const methodMap: Record<string, (params: unknown) => Promise<unknown>> = {
        signToken: (p) => rpcServer.signToken(p),
        verifyToken: (p) => rpcServer.verifyToken(p),
        revokeToken: (p) => rpcServer.revokeToken(p),
        getPublicKey: () => rpcServer.getPublicKey(),
        getJwks: () => rpcServer.getJwks(),
        getCurrentKeyId: () => rpcServer.getCurrentKeyId(),
        rotate: (p) => rpcServer.rotate(p),
        createFirstAdmin: (p) => rpcServer.createFirstAdmin(p),
        getBootstrapStatus: () => rpcServer.getBootstrapStatus(),
        login: (p) => rpcServer.login(p),
        createServiceAccount: (p) => rpcServer.createServiceAccount(p),
        listServiceAccounts: (p) => rpcServer.listServiceAccounts(p),
        deleteServiceAccount: (p) => rpcServer.deleteServiceAccount(p),
        authenticateApiKey: (p) => rpcServer.authenticateApiKey(p),
      }

      const handler = methodMap[method]
      if (!handler) {
        return c.json({ success: false, error: `Unknown method: ${method}` }, 400)
      }

      const result = await handler(params)
      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error'
      return c.json({ success: false, error: message }, 500)
    }
  })

  // WebSocket handler for capnweb RPC (for programmatic clients)
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })

  return app
}
