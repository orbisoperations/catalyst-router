import { newRpcResponse } from '@hono/capnweb'
import { RpcTarget } from 'capnweb'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'

import {
  Action,
  jwtToEntity,
  Role,
  type CatalystPolicyEngine,
  type IKeyManager,
  type TokenManager,
} from '@catalyst/authorization'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import type { Counter, Histogram } from '@opentelemetry/api'
import type { ApiKeyService } from '../api-key-service.js'
import type { BootstrapService } from '../bootstrap.js'
import type { LoginService } from '../login.js'
import {
  CreateFirstAdminRequestSchema,
  LoginRequestSchema,
  type AuthorizeActionRequest,
  type AuthorizeActionResult,
  type CertHandlers,
  type CreateFirstAdminResponse,
  type GetBootstrapStatusResponse,
  type LoginResponse,
  type PermissionsHandlers,
  type TokenHandlers,
  type ValidationHandlers,
} from './schema.js'

export class AuthRpcServer extends RpcTarget {
  private systemToken?: string
  private readonly logger: ServiceTelemetry['logger']
  private readonly signingDuration: Histogram
  private readonly verificationDuration: Histogram
  private readonly keyRotations: Counter

  setSystemToken(token: string): void {
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
    private policyService?: CatalystPolicyEngine,
    private nodeId: string = 'unknown',
    private domainId: string = '',
    telemetry: ServiceTelemetry = TelemetryBuilder.noop('auth')
  ) {
    super()
    this.logger = telemetry.logger.getChild('rpc')

    this.signingDuration = telemetry.meter.createHistogram('auth.token.signing.duration', {
      description: 'Duration of token signing operations',
      unit: 's',
    })
    this.verificationDuration = telemetry.meter.createHistogram(
      'auth.token.verification.duration',
      {
        description: 'Duration of token verification operations',
        unit: 's',
      }
    )
    this.keyRotations = telemetry.meter.createCounter('auth.key.rotations', {
      description: 'Number of key rotation operations',
      unit: '{rotation}',
    })
  }

  private async timed<T>(
    histogram: Histogram,
    fn: () => Promise<T>,
    attrs?: Record<string, string>
  ): Promise<T> {
    const start = performance.now()
    try {
      const result = await fn()
      histogram.record((performance.now() - start) / 1000, attrs)
      return result
    } catch (err) {
      histogram.record((performance.now() - start) / 1000, attrs)
      throw err
    }
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

    const token = await this.timed(this.signingDuration, () =>
      this.tokenManager.mint({
        subject: result.userId!,
        expiresAt: Date.now() + 3600000,
        roles: [Role.ADMIN],
        entity: {
          id: result.userId!,
          name: 'First Admin',
          type: 'user',
          role: Role.ADMIN,
        },
        claims: {
          orgId: 'default',
        },
      })
    )

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
    const auth = await this.timed(this.verificationDuration, () => this.tokenManager.verify(token))
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
    const principal = jwtToEntity(auth.payload as Record<string, unknown>)
    const builder = this.policyService?.entityBuilderFactory.createEntityBuilder()
    if (!builder) {
      return { error: 'Policy service not configured' }
    }
    builder.entity(principal.uid.type, principal.uid.id).setAttributes(principal.attrs)
    builder
      .entity('CATALYST::AdminPanel', 'admin-panel')
      .setAttributes({ nodeId: this.nodeId, domainId: this.domainId })
    const entities = builder.build()
    const autorizedResult = this.policyService?.isAuthorized({
      principal: principal.uid,
      action: 'CATALYST::Action::MANAGE',
      resource: { type: 'CATALYST::AdminPanel', id: 'admin-panel' },
      entities: entities.getAll(),
      context: {},
    })
    if (autorizedResult?.type === 'failure') {
      this.logger.error`Policy service error: ${autorizedResult.errors}`
      return { error: 'Error authorizing request' }
    }

    if (autorizedResult?.type === 'evaluated' && !autorizedResult.allowed) {
      this.logger.error`Authorization denied - diagnostics: ${autorizedResult?.diagnostics}`
      return { error: 'Permission denied: ADMIN role required' }
    }

    return {
      create: async (request) => {
        return this.timed(this.signingDuration, () =>
          this.tokenManager.mint({
            subject: request.subject,
            entity: {
              ...request.entity,
              role: (request.roles as Role[])[0] || Role.USER, // Use primary role
            },
            roles: request.roles as Role[],
            sans: request.sans,
            expiresIn: request.expiresIn,
            claims: {},
          })
        )
      },
      revoke: async (request) => {
        await this.tokenManager.revoke({ jti: request.jti, san: request.san })
      },
      list: async (request) => {
        return this.tokenManager.listTokens(request)
      },
    }
  }

  /**
   * Certificate/Key management sub-api.
   * Requires 'ADMIN' role.
   */
  async certs(token: string): Promise<CertHandlers | { error: string }> {
    const auth = await this.timed(this.verificationDuration, () => this.tokenManager.verify(token))
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    const principal = jwtToEntity(auth.payload as Record<string, unknown>)
    const builder = this.policyService?.entityBuilderFactory.createEntityBuilder()
    if (!builder) {
      return { error: 'Policy service not configured' }
    }
    builder.entity(principal.uid.type, principal.uid.id).setAttributes(principal.attrs)
    builder
      .entity('CATALYST::AdminPanel', 'admin-panel')
      .setAttributes({ nodeId: this.nodeId, domainId: this.domainId })
    const entities = builder.build()
    const autorizedResult = this.policyService?.isAuthorized({
      principal: principal.uid,
      action: { type: 'CATALYST::Action', id: Action.MANAGE },
      resource: { type: 'CATALYST::AdminPanel', id: 'admin-panel' },
      entities: entities.getAll(),
      context: {},
    })

    if (autorizedResult?.type === 'failure') {
      return { error: 'Error authorizing request' }
    }

    if (autorizedResult?.type === 'evaluated' && !autorizedResult.allowed) {
      return { error: 'Permission denied: ADMIN role required' }
    }

    return {
      list: async () => {
        const jwks = await this.keyManager.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
      rotate: async (request) => {
        const result = await this.keyManager.rotate(request)
        this.keyRotations.add(1)
        return {
          success: true,
          previousKeyId: result.previousKeyId,
          newKeyId: result.newKeyId,
          gracePeriodEndsAt: result.gracePeriodEndsAt?.toISOString(),
        }
      },
      getTokensByCert: async (request) => {
        return this.tokenManager.listTokens({
          certificateFingerprint: request.fingerprint,
        })
      },
    }
  }

  /**
   * Token validation and public metadata sub-api.
   * Accessible with any valid token or unauthenticated for JWKS.
   */
  async validation(token: string): Promise<ValidationHandlers | { error: string }> {
    const auth = await this.timed(this.verificationDuration, () => this.tokenManager.verify(token))
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    return {
      validate: async (req: { token: string; audience?: string }) => {
        const result = await this.timed(this.verificationDuration, () =>
          this.tokenManager.verify(req.token, { audience: req.audience })
        )
        if (!result.valid) return { valid: false, error: result.error }
        return { valid: true, payload: result.payload }
      },
      getRevocationList: async () => {
        return this.tokenManager.getRevocationList()
      },
      getJWKS: async () => {
        const jwks = await this.keyManager.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
    }
  }

  /**
   * Permissions sub-API for Cedar-based authorization checks.
   * Accessible with any valid token.
   */
  async permissions(token: string): Promise<PermissionsHandlers | { error: string }> {
    const logger = this.logger.getChild('permissions')

    // Verify the token
    const auth = await this.timed(this.verificationDuration, () => this.tokenManager.verify(token))
    if (!auth.valid) {
      logger.warn`Token verification failed: ${auth.error}`
      return { error: 'Invalid token' }
    }

    if (!this.policyService) {
      logger.error`Policy service not configured`
      return { error: 'Policy service not configured' }
    }

    return {
      authorizeAction: async (request: AuthorizeActionRequest): Promise<AuthorizeActionResult> => {
        // Extract principal from JWT
        const principal = jwtToEntity(auth.payload as Record<string, unknown>)

        // Parse action
        const actionId = request.action.toUpperCase().replace(/[:-]/g, '_')

        // Build resource entity (AdminPanel for now, can be extended)
        const builder = this.policyService!.entityBuilderFactory.createEntityBuilder()
        builder.entity(principal.uid.type, principal.uid.id).setAttributes(principal.attrs)
        builder.entity('CATALYST::AdminPanel', 'admin-panel').setAttributes({
          nodeId: request.nodeContext.nodeId,
          domainId: request.nodeContext.domains[0] || '', // Use first domain
        })

        const entities = builder.build()

        // Perform Cedar authorization
        const result = this.policyService!.isAuthorized({
          principal: principal.uid,
          action: `CATALYST::Action::${actionId}`,
          resource: { type: 'CATALYST::AdminPanel', id: 'admin-panel' },
          entities: entities.getAll(),
          context: {},
        })

        logger.info`Authorization check - action: ${request.action}, allowed: ${result.type === 'evaluated' && result.allowed}`

        // Handle authorization result
        if (result.type === 'failure') {
          logger.error`Authorization system error: ${result.errors.join(', ')}`
          return {
            success: false,
            errorType: 'system_error',
            reason: 'Authorization system error',
          }
        }

        if (result.type === 'evaluated' && !result.allowed) {
          logger.warn`Permission denied for action: ${request.action}, reasons: ${result.reasons.join(', ')}`
          return {
            success: false,
            errorType: 'permission_denied',
            reasons: result.reasons,
          }
        }

        // Success - allowed
        return {
          success: true,
          allowed: true,
        }
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
