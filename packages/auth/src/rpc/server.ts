import { newRpcResponse } from '@hono/capnweb'
import { RpcTarget } from 'capnweb'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'

import type { IKeyManager } from '../key-manager/types.js'
import { type TokenManager, type Role, LocalTokenManager } from '@catalyst/authorization'
import type { BootstrapService } from '../bootstrap.js'
import type { IKeyManager } from '../key-manager/types.js'
import type { LoginService } from '../login.js'
import type { Role } from '../permissions.js'
import type { CatalystPolicyEngine } from '../policies/types.js'
import { type RevocationStore } from '../revocation.js'
import {
  CreateFirstAdminRequestSchema,
  LoginRequestSchema,
  type AdminHandlers,
  type RotateResponse,
  type TokenHandlers,
  type CertHandlers,
  type ValidationHandlers,
  type CreateFirstAdminResponse,
  type GetBootstrapStatusResponse,
  type LoginResponse,
  type ValidationHandlers,
} from './schema.js'

export class AuthRpcServer extends RpcTarget {
  private systemToken?: string

  setSystemToken(token: string) {
    this.systemToken = token
  }

  getSystemToken(): string | undefined {
    return this.systemToken
  }

  constructor(
    private keyManager: IKeyManager,
    private tokenManager: TokenManager,
    private bootstrapService?: BootstrapService,
    private loginService?: LoginService,
    private apiKeyService?: ApiKeyService,
    private policyService?: CatalystPolicyEngine
  ) {
    super()
  }

  // --- Public API ---

  async login(request: unknown): Promise<LoginResponse> {
    if (!this.loginService) {
      return { success: false, error: 'Login not configured' }
    }
    const parsed = LoginRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }
    const result = await this.loginService.login(parsed.data)
    if (!result.success) {
      return { success: false, error: result.error ?? 'Login failed' }
    }
    if (!this.policyService) {
      return { success: false, error: 'Policy service not configured' }
    }
    return {
      success: true,
      token: result.token!,
      expiresAt: result.expiresAt!.toISOString(),
    }
  }

  async createFirstAdmin(request: unknown): Promise<CreateFirstAdminResponse> {
    if (!this.bootstrapService) {
      return { success: false, error: 'Bootstrap not configured' }
    }
    const parsed = CreateFirstAdminRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }
    const result = await this.bootstrapService.createFirstAdmin(parsed.data)
    if (!result.success) {
      return { success: false, error: result.error ?? 'Bootstrap failed' }
    }

    const token = await this.tokenManager.mint({
      subject: result.userId!,
      expiresIn: '1h',
      roles: ['ADMIN'],
      entity: {
        id: result.userId!,
        name: 'First Admin',
        type: 'user',
      },
      claims: {
        orgId: 'default',
      },
    })

    return {
      success: true,
      userId: result.userId!,
      token,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }
  }

  async getBootstrapStatus(): Promise<GetBootstrapStatusResponse> {
    if (!this.bootstrapService) {
      return { initialized: false, used: false }
    }
    return this.bootstrapService.getBootstrapStatus()
  }

  // --- Progressive API Entry Points ---

  /**
   * Token management sub-api.
   * Requires 'ADMIN' role.
   */
  async tokens(token: string): Promise<TokenHandlers | { error: string }> {
    const auth = await this.tokenManager.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    // For @team:
    // A simple Demo/light integration with the policy service
    //
    // for @GABRIEL; TODO:
    // just realized that (MAYBE) I can abstract this a bit more
    // and do another class on top and be like:
    //
    // Ill give it some thought and see if it makes sense to do so.
    //
    // seems like the pattern of builder, authorized, will be very repetitive
    const builder = this.policyService?.entityBuilderFactory.createEntityBuilder()
    if (!builder) {
      return { error: 'Policy service not configured' }
    }
    builder.add('User', auth.payload)
    const entities = builder.build()
    const autorizedResult = this.policyService?.isAuthorized({
      principal: entities.entityRef('User', auth.payload.id as string),
      action: { type: 'Action', id: 'login' },
      resource: { type: 'AdminPanel', id: 'admin-panel' },
      entities: entities.getAll(),
      context: {},
    })
    if (autorizedResult?.type === 'failure') {
      // log for telemetry
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'Error on policy service',
          error: autorizedResult.errors,
        })
      )
      return { error: 'Error authorizing request' }
    }
    if (!autorizedResult?.allowed) {
      // log for telemetry
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'Error authorizing request',
          diagnostics: autorizedResult?.diagnostics,
          reasons: autorizedResult?.reasons,
          decision: autorizedResult?.decision,
          allowed: autorizedResult?.allowed,
        })
      )
      return { error: 'Permission denied: admin role required' }
    }

    const roles = (auth.payload.roles as string[]) || []
    if (!roles.includes('admin')) {
      return { error: 'Permission denied: admin role required' }
    }

    return {
      create: async (request) => {
        return this.tokenManager.mint({
          subject: request.subject,
          entity: request.entity,
          roles: request.roles as Role[],
          sans: request.sans,
          expiresIn: request.expiresIn,
          claims: {},
        })
      },
      revoke: async (request) => {
        await this.tokenManager.revoke({ jti: request.jti, san: request.san })
      },
      list: async (request) => {
        if (this.tokenManager instanceof LocalTokenManager) {
          return this.tokenManager.getStore().listTokens(request)
        }
        return []
      },
    }
  }

  /**
   * Certificate/Key management sub-api.
   * Requires 'ADMIN' role.
   */
  async certs(token: string): Promise<CertHandlers | { error: string }> {
    const auth = await this.tokenManager.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    const roles = (auth.payload.roles as string[]) || []
    if (!roles.includes('ADMIN')) {
      return { error: 'Permission denied: ADMIN role required' }
    }

    return {
      list: async () => {
        const jwks = await this.keyManager.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
      rotate: async (request) => {
        const result = await this.keyManager.rotate(request)
        return {
          success: true,
          previousKeyId: result.previousKeyId,
          newKeyId: result.newKeyId,
          gracePeriodEndsAt: result.gracePeriodEndsAt?.toISOString(),
        }
      },
      getTokensByCert: async (request) => {
        if (this.tokenManager instanceof LocalTokenManager) {
          return this.tokenManager.getStore().listTokens({
            certificateFingerprint: request.fingerprint,
          })
        }
        return []
      },
    }
  }

  /**
   * Token validation and public metadata sub-api.
   * Accessible with any valid token or unauthenticated for JWKS.
   */
  async validation(token: string): Promise<ValidationHandlers | { error: string }> {
    const auth = await this.tokenManager.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    return {
      validate: async (req: { token: string; audience?: string }) => {
        const result = await this.tokenManager.verify(req.token, { audience: req.audience })
        if (!result.valid) return { valid: false, error: result.error }
        return { valid: true, payload: result.payload }
      },
      getRevocationList: async () => {
        if (this.tokenManager instanceof LocalTokenManager) {
          return this.tokenManager.getStore().getRevocationList()
        }
        return []
      },
      getJWKS: async () => {
        const jwks = await this.keyManager.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
    }
  }
}

export function createAuthRpcHandler(rpcServer: AuthRpcServer): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })

  // Note: For progressive API, HTTP POST JSON-RPC is trickier as it involves
  // nested handler sets. capnweb handles this via references over WebSocket.
  // For now, we prioritize the WebSocket/capnweb interface for progressive usage.

  return app
}
