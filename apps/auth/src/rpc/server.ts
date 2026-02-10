import { newRpcResponse } from '@hono/capnweb'
import { RpcTarget } from 'capnweb'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'

import type { JWTTokenFactory } from '@catalyst/authorization'
import { jwtToEntity, Role, type CatalystPolicyEngine } from '@catalyst/authorization'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import {
  type AuthorizeActionRequest,
  type AuthorizeActionResult,
  type CertHandlers,
  type PermissionsHandlers,
  type TokenHandlers,
  type ValidationHandlers,
} from './schema.js'

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: '30s', '5m', '1h', '7d', '52w'
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(s|m|h|d|w)$/i)
  if (!match) throw new Error(`Invalid duration format: ${duration}`)
  const value = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  }
  return value * multipliers[unit]
}

export class AuthRpcServer extends RpcTarget {
  private systemToken?: string

  setSystemToken(token: string) {
    this.systemToken = token
  }

  getSystemToken(): string | undefined {
    return this.systemToken
  }

  constructor(
    private tokenFactory: JWTTokenFactory,
    private telemetry: ServiceTelemetry,
    private policyService?: CatalystPolicyEngine,
    private nodeId: string = 'unknown',
    private domainId: string = ''
  ) {
    super()
  }

  // --- Progressive API Entry Points ---

  /**
   * Token management sub-api.
   * Requires 'ADMIN' role.
   */
  async tokens(token: string): Promise<TokenHandlers | { error: string }> {
    const logger = this.telemetry.logger
    const auth = await this.tokenFactory.verify(token)
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
      void logger.error`Policy service error: ${autorizedResult.errors}`
      return { error: 'Error authorizing request' }
    }

    if (autorizedResult?.type === 'evaluated' && !autorizedResult.allowed) {
      void logger.warn`Permission denied: decision=${autorizedResult.decision}, reasons=${autorizedResult.reasons}`
      return { error: 'Permission denied: ADMIN role required' }
    }

    return {
      create: async (request) => {
        return this.tokenFactory.mint({
          subject: request.subject,
          entity: {
            ...request.entity,
            role: (request.roles as Role[])[0] || Role.USER, // Use primary role
          },
          roles: request.roles as Role[],
          sans: request.sans,
          expiresAt: request.expiresIn ? Date.now() + parseDuration(request.expiresIn) : undefined,
          claims: {},
        })
      },
      revoke: async (request) => {
        await this.tokenFactory.revoke({ jti: request.jti, san: request.san })
      },
      list: async (request) => {
        return this.tokenFactory.listTokens(request)
      },
    }
  }

  /**
   * Certificate/Key management sub-api.
   * Requires 'ADMIN' role.
   */
  async certs(token: string): Promise<CertHandlers | { error: string }> {
    const auth = await this.tokenFactory.verify(token)
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
      action: 'CATALYST::Action::MANAGE',
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
        const jwks = await this.tokenFactory.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
      rotate: async (request) => {
        const result = await this.tokenFactory.rotate(request)
        return {
          success: true,
          previousKeyId: result.previousKeyId,
          newKeyId: result.newKeyId,
          gracePeriodEndsAt: result.gracePeriodEndsAt?.toISOString(),
        }
      },
      getTokensByCert: async (request) => {
        return this.tokenFactory.listTokens({
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
    const auth = await this.tokenFactory.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    return {
      validate: async (req: { token: string; audience?: string }) => {
        const result = await this.tokenFactory.verify(req.token, { audience: req.audience })
        if (!result.valid) return { valid: false, error: result.error }
        return { valid: true, payload: result.payload }
      },
      getRevocationList: async () => {
        return this.tokenFactory.getRevocationList()
      },
      getJWKS: async () => {
        const jwks = await this.tokenFactory.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
    }
  }

  /**
   * Permissions sub-API for Cedar-based authorization checks.
   * Accessible with any valid token.
   */
  async permissions(token: string): Promise<PermissionsHandlers | { error: string }> {
    const logger = this.telemetry.logger

    // Verify the token
    const auth = await this.tokenFactory.verify(token)
    if (!auth.valid) {
      void logger.warn`Token verification failed: ${auth.error}`
      return { error: 'Invalid token' }
    }

    if (!this.policyService) {
      void logger.error`Policy service not configured`
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

        void logger.info`Authorization check - action: ${request.action}, allowed: ${result.type === 'evaluated' && result.allowed}`

        // Handle authorization result
        if (result.type === 'failure') {
          void logger.error`Authorization system error: ${result.errors.join(', ')}`
          return {
            success: false,
            errorType: 'system_error',
            reason: 'Authorization system error',
          }
        }

        if (result.type === 'evaluated' && !result.allowed) {
          void logger.warn`Permission denied for action: ${request.action}, reasons: ${result.reasons.join(', ')}`
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
