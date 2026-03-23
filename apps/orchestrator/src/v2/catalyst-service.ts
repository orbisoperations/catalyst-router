import { newRpcResponse } from '@hono/capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import { Principal } from '@catalyst/authorization'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { withWideEvent } from '@catalyst/telemetry'
import { Hono } from 'hono'
import { getUpgradeWebSocket } from '@catalyst/service'
import { OrchestratorServiceV2 } from './service.js'
import { AdapterHealthChecker } from './adapter-health.js'
import { WebSocketPeerTransport } from './ws-transport.js'
import { HttpPeerTransport } from './http-transport.js'
import type { PeerTransport } from './transport.js'
import { createNetworkClient, createDataChannelClient, createIBGPClient } from './rpc.js'
import type { TokenValidator } from './rpc.js'
import { RouteTableView, ActionSchema } from '@catalyst/routing/v2'

/**
 * Auth Service RPC API for token minting.
 */
interface AuthRpcApi {
  tokens(token: string): Promise<
    | {
        create(request: {
          subject: string
          entity: {
            id: string
            name: string
            type: 'user' | 'service'
            nodeId?: string
            trustedNodes?: string[]
            trustedDomains?: string[]
          }
          principal: string
          sans?: string[]
          expiresIn?: string
        }): Promise<string>
        revoke(request: { jti?: string; san?: string }): Promise<void>
        list(request: { certificateFingerprint?: string; san?: string }): Promise<unknown[]>
      }
    | { error: string }
  >
}

interface AuthServicePermissionsHandlers {
  authorizeAction(request: {
    action: string
    nodeContext: { nodeId: string; domains: string[] }
  }): Promise<
    | { success: true; allowed: boolean }
    | {
        success: false
        errorType: string
        reason?: string
        reasons?: string[]
      }
  >
}

interface AuthServiceApi {
  permissions(token: string): Promise<AuthServicePermissionsHandlers | { error: string }>
}

// Token refresh threshold: refresh when 80% of TTL has elapsed
const REFRESH_THRESHOLD = 0.8
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const REFRESH_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour

// mintNodeToken retry parameters
const MINT_TOKEN_MAX_ATTEMPTS = 5
const MINT_TOKEN_BASE_DELAY_MS = 1_000
const _MINT_TOKEN_MAX_DELAY_MS = 30_000

/**
 * V2 orchestrator service, wrapped in CatalystService for Hono server integration.
 *
 * Wires together:
 * - OrchestratorServiceV2 (bus, tick manager, reconnect manager, journal)
 * - WebSocketPeerTransport (capnweb RPC to remote orchestrators)
 * - Auth token minting and refresh
 * - RPC endpoint via capnweb
 */
export class OrchestratorService extends CatalystService {
  readonly info = { name: 'orchestrator', version: '2.0.0' }
  readonly handler = new Hono()

  private _v2!: OrchestratorServiceV2
  private _healthChecker: AdapterHealthChecker | undefined
  private _nodeToken: string | undefined
  private _tokenIssuedAt: number | undefined
  private _tokenExpiresAt: number | undefined
  private _refreshInterval: ReturnType<typeof setInterval> | undefined
  private _authClient: ReturnType<typeof newWebSocketRpcSession<AuthServiceApi>> | undefined

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get v2(): OrchestratorServiceV2 {
    return this._v2
  }

  protected async onInitialize(): Promise<void> {
    // Mint node token if auth is configured
    await this.mintNodeToken()

    // Set up periodic token refresh
    if (this.config.orchestrator?.auth) {
      this._refreshInterval = setInterval(
        () => this.refreshNodeTokenIfNeeded(),
        REFRESH_CHECK_INTERVAL
      )
      this.telemetry.logger.info('Token refresh check enabled (interval={interval})', {
        'event.name': 'node.token.refresh_scheduled',
        interval: '1h',
      })
    }

    // Set up auth client for token validation
    if (this.config.orchestrator?.auth) {
      this._authClient = newWebSocketRpcSession<AuthServiceApi>(
        this.config.orchestrator.auth.endpoint
      )
    }

    // Build the transport and v2 service.
    // Default to WebSocket; HTTP available for environments without persistent connections.
    const transportType = process.env.CATALYST_TRANSPORT_TYPE === 'http' ? 'http' : 'ws'
    const localNodeInfo = {
      name: this.config.node.name,
      domains: this.config.node.domains,
      envoyAddress: this.config.node.envoyAddress,
    }
    const transport: PeerTransport =
      transportType === 'http'
        ? new HttpPeerTransport({ localNodeInfo })
        : new WebSocketPeerTransport({ localNodeInfo })

    const orchestratorConfig = {
      node: {
        ...this.config.node,
        endpoint: this.config.node.endpoint!,
      },
      ...(this.config.orchestrator ?? {}),
    }

    this._v2 = new OrchestratorServiceV2({
      config: orchestratorConfig,
      transport,
      nodeToken: this._nodeToken,
      journal: this.config.orchestrator?.journal,
    })

    const adapterHealthConfig = this.config.orchestrator?.adapterHealth
    if (adapterHealthConfig?.enabled !== false) {
      this._healthChecker = new AdapterHealthChecker({
        intervalMs: adapterHealthConfig?.intervalMs,
        timeoutMs: adapterHealthConfig?.timeoutMs,
        dispatchFn: (action) => {
          // Validate action shape matches the Action schema before dispatching
          const validated = ActionSchema.parse(action)
          return this._v2.bus.dispatch(validated).then(() => {})
        },
      })
      // Health checks read a snapshot of routes (safe). Status changes are
      // dispatched into the bus via dispatchFn, which updates the RIB and
      // triggers iBGP propagation to peers.
      this._healthChecker.start(() => this._v2.bus.getStateSnapshot().local.routes)
    }

    // Build the token validator
    const validator = this.buildValidator()

    // Mount RPC route — exposes the same PublicApi shape as v1
    this.handler.all('/rpc', (c) => {
      return newRpcResponse(
        c,
        {
          getNetworkClient: (token: string) => createNetworkClient(this._v2.bus, token, validator),
          getDataChannelClient: (token: string) =>
            createDataChannelClient(this._v2.bus, token, validator),
          getIBGPClient: (token: string) => createIBGPClient(this._v2.bus, token, validator),
        },
        {
          upgradeWebSocket: getUpgradeWebSocket(c),
        }
      )
    })

    // TODO: Add token validation — currently unauthenticated. Exposes topology
    // (peer endpoints, routes, connection status) but no credentials. Safe for
    // internal/dev use; needs auth before production exposure.
    const bus = this._v2.bus
    this.handler.get('/api/state', (c) => {
      const snapshot = bus.getStateSnapshot()
      if (this._healthChecker) {
        this._healthChecker.applyHealth(snapshot.local.routes)
      }
      return c.json(new RouteTableView(snapshot).toPublic())
    })

    // Start tick manager
    this._v2.start()

    this.telemetry.logger.info('Orchestrator v2 running as {nodeName}', {
      'event.name': 'orchestrator.started',
      'catalyst.orchestrator.node.name': this.config.node.name,
    })
  }

  protected async onShutdown(): Promise<void> {
    this._healthChecker?.stop()
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval)
      this._refreshInterval = undefined
    }
    await this._v2.stop()
  }

  private buildValidator(): TokenValidator {
    return buildTokenValidator({
      authClient: this._authClient,
      allowNoAuth: this.config.orchestrator?.allowNoAuth ?? false,
      config: this.config,
      logger: this.telemetry.logger,
    })
  }

  private async mintNodeToken(
    maxAttempts = MINT_TOKEN_MAX_ATTEMPTS,
    _baseDelayMs = MINT_TOKEN_BASE_DELAY_MS
  ): Promise<void> {
    await withWideEvent('orchestrator.token_mint', this.telemetry.logger, async (event) => {
      if (!this.config.orchestrator?.auth) {
        event.set('catalyst.orchestrator.token_mint.skipped', true)
        return
      }

      const { endpoint, systemToken } = this.config.orchestrator.auth
      event.set('catalyst.orchestrator.auth.endpoint', endpoint)

      let _lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const authClient = newWebSocketRpcSession<AuthRpcApi>(endpoint)
        const tokensApi = await authClient.tokens(systemToken)

        if ('error' in tokensApi) {
          throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
        }

        this._nodeToken = await tokensApi.create({
          subject: this.config.node.name,
          entity: {
            id: this.config.node.name,
            name: this.config.node.name,
            type: 'service',
            nodeId: this.config.node.name,
            trustedNodes: [],
            trustedDomains: this.config.node.domains,
          },
          principal: Principal.NODE,
          expiresIn: '7d',
        })

        const now = Date.now()
        this._tokenIssuedAt = now
        this._tokenExpiresAt = now + TOKEN_TTL_MS

        event.set('catalyst.orchestrator.auth.expires_at', this._tokenExpiresAt)

        // Propagate token to the v2 service if already initialized
        if (this._v2) {
          this._v2.setNodeToken(this._nodeToken)
        }
      }
    })
  }

  private async refreshNodeTokenIfNeeded(): Promise<void> {
    if (!this.config.orchestrator?.auth || !this._tokenIssuedAt || !this._tokenExpiresAt) {
      return
    }

    const now = Date.now()
    const totalLifetime = this._tokenExpiresAt - this._tokenIssuedAt
    const refreshTime = this._tokenIssuedAt + totalLifetime * REFRESH_THRESHOLD

    if (now >= refreshTime) {
      await withWideEvent('orchestrator.token_refresh', this.telemetry.logger, async () => {
        await this.mintNodeToken()
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone token validator factory — exported for testing
// ---------------------------------------------------------------------------

interface BuildTokenValidatorOptions {
  authClient: ReturnType<typeof newWebSocketRpcSession<AuthServiceApi>> | undefined
  allowNoAuth: boolean
  config: { node: { name: string; domains: string[] } }
  logger: {
    warn: (message: string, attrs?: Record<string, unknown>) => void
    error: (message: string, attrs?: Record<string, unknown>) => void
  }
}

export function buildTokenValidator({
  authClient,
  allowNoAuth,
  config,
  logger,
}: BuildTokenValidatorOptions): TokenValidator {
  if (!authClient) {
    if (allowNoAuth) {
      return {
        async validateToken() {
          return { valid: true }
        },
      }
    }
    // No auth configured — reject all tokens (fail-closed)
    return {
      async validateToken() {
        return { valid: false, error: 'Auth not configured' }
      },
    }
  }

  return {
    async validateToken(
      token: string,
      action: string
    ): Promise<{ valid: true } | { valid: false; error: string }> {
      try {
        const permissionsApi = await authClient.permissions(token)
        if ('error' in permissionsApi) {
          logger.warn('Token validation failed for action {action}', {
            'event.name': 'auth.token.validation.failed',
            'catalyst.orchestrator.action': action,
            error: permissionsApi.error,
          })
          return { valid: false, error: 'Authorization failed' }
        }

        const result = await permissionsApi.authorizeAction({
          action,
          nodeContext: {
            nodeId: config.node.name,
            domains: config.node.domains,
          },
        })

        if (!result.success) {
          logger.warn('Authorization denied for action {action}', {
            'event.name': 'auth.authorization.denied',
            'catalyst.orchestrator.action': action,
            'catalyst.orchestrator.error_type': result.errorType,
          })
          return { valid: false, error: 'Authorization failed' }
        }

        if (!result.allowed) {
          return { valid: false, error: 'Authorization failed' }
        }

        return { valid: true }
      } catch (error) {
        logger.error('Token validation error for action {action}', {
          'event.name': 'auth.token.validation.error',
          'catalyst.orchestrator.action': action,
          error,
        })
        return { valid: false, error: 'Authorization failed' }
      }
    },
  }
}
