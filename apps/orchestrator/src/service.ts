import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { newRpcResponse } from '@hono/capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import { Role } from '@catalyst/authorization'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { CatalystNodeBus } from './orchestrator.js'

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
            role: string
            nodeId?: string
            trustedNodes?: string[]
            trustedDomains?: string[]
          }
          roles: string[]
          sans?: string[]
          expiresIn?: string
        }): Promise<string>
        revoke(request: { jti?: string; san?: string }): Promise<void>
        list(request: { certificateFingerprint?: string; san?: string }): Promise<unknown[]>
      }
    | { error: string }
  >
}

// Token refresh threshold: refresh when 80% of TTL has elapsed
const REFRESH_THRESHOLD = 0.8
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
const REFRESH_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour

export class OrchestratorService extends CatalystService {
  readonly info = { name: 'orchestrator', version: '0.0.0' }
  readonly handler = new Hono()

  private _bus!: CatalystNodeBus
  private _nodeToken: string | undefined
  private _tokenIssuedAt: Date | undefined
  private _tokenExpiresAt: Date | undefined
  private _refreshInterval: ReturnType<typeof setInterval> | undefined

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get bus(): CatalystNodeBus {
    return this._bus
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
      console.log('Token refresh check enabled (every hour)')
    }

    // Build the CatalystNodeBus
    this._bus = new CatalystNodeBus({
      config: this.config.orchestrator
        ? {
            ...this.config.orchestrator,
            node: {
              ...this.config.node,
              endpoint: this.config.node.endpoint!, // Orchestrator requires an endpoint
            },
          }
        : {
            node: {
              ...this.config.node,
              endpoint: this.config.node.endpoint!,
            },
          },
      connectionPool: { type: 'ws' },
      nodeToken: this._nodeToken,
      authEndpoint: this.config.orchestrator?.auth?.endpoint,
    })

    // Mount RPC route
    this.handler.all('/rpc', (c) => {
      return newRpcResponse(c, this._bus.publicApi(), {
        upgradeWebSocket,
      })
    })

    const nodeName = this.config.node.name
    console.log(`Orchestrator (Next) running as ${nodeName}`)
    console.log('NEXT_ORCHESTRATOR_STARTED')
  }

  protected async onShutdown(): Promise<void> {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval)
      this._refreshInterval = undefined
    }
  }

  private async mintNodeToken(): Promise<void> {
    if (!this.config.orchestrator?.auth) {
      console.log('No auth service configured - skipping node token mint')
      return
    }

    const { endpoint, systemToken } = this.config.orchestrator.auth
    console.log(`Connecting to auth service at ${endpoint}`)

    try {
      const authClient = newWebSocketRpcSession<AuthRpcApi>(endpoint)
      const tokensApi = await authClient.tokens(systemToken)

      if ('error' in tokensApi) {
        throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
      }

      // Mint NODE token
      this._nodeToken = await tokensApi.create({
        subject: this.config.node.name,
        entity: {
          id: this.config.node.name,
          name: this.config.node.name,
          type: 'service',
          role: Role.NODE,
          nodeId: this.config.node.name,
          trustedNodes: [], // Empty for now - could be populated from peer config
          trustedDomains: this.config.node.domains, // Domains this node trusts
        },
        roles: [Role.NODE],
        expiresIn: '7d', // Node token valid for 7 days
      })

      // Track issue and expiry times for refresh logic
      this._tokenIssuedAt = new Date()
      this._tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS)

      console.log(`Node token minted successfully for ${this.config.node.name}`)
      console.log(`Token issued at: ${this._tokenIssuedAt.toISOString()}`)
      console.log(`Token expires at: ${this._tokenExpiresAt.toISOString()}`)
    } catch (error) {
      console.error('Failed to mint node token:', error)
      throw error
    }
  }

  private async refreshNodeTokenIfNeeded(): Promise<void> {
    if (!this.config.orchestrator?.auth || !this._tokenIssuedAt || !this._tokenExpiresAt) {
      return
    }

    const now = Date.now()
    const issuedTime = this._tokenIssuedAt.getTime()
    const expiryTime = this._tokenExpiresAt.getTime()
    const totalLifetime = expiryTime - issuedTime
    const refreshTime = issuedTime + totalLifetime * REFRESH_THRESHOLD

    if (now >= refreshTime) {
      console.log('Node token approaching expiration, refreshing...')
      try {
        await this.mintNodeToken()
        console.log('Node token refreshed successfully')
      } catch (error) {
        console.error('Failed to refresh node token:', error)
        // Don't throw - keep using existing token until it expires
      }
    }
  }
}
