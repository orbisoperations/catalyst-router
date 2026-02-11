import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { newRpcResponse } from '@hono/capnweb'
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from 'capnweb'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { z } from 'zod'

// Define the configuration schema
export const ServiceConfigSchema = z.object({
  name: z.string(),
  url: z.string(),
  token: z.string().optional(), // Optional auth token for the service
})

export const GatewayConfigSchema = z.object({
  services: z.array(ServiceConfigSchema),
})

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>

export type ConfigUpdateCallback = (config: GatewayConfig) => Promise<GatewayUpdateResult>

export const GatewayUpdateResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type GatewayUpdateResult = z.infer<typeof GatewayUpdateResultSchema>

export interface ConfigClient {
  updateConfig(config: unknown): Promise<GatewayUpdateResult>
}

export interface GatewayPublicApi {
  getConfigClient(
    token: string
  ): Promise<{ success: true; client: ConfigClient } | { success: false; error: string }>
}

/**
 * Auth Service permissions API shape (mirrors orchestrator's pattern).
 */
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
  /** Pure JWT verification - checks signature, expiry, and revocation only */
  authenticate(
    token: string
  ): Promise<{ valid: true; payload: Record<string, unknown> } | { valid: false; error: string }>
  /** Cedar policy evaluation - verifies token AND checks action permissions */
  permissions(token: string): Promise<AuthServicePermissionsHandlers | { error: string }>
}

export interface GatewayRpcServerOptions {
  authEndpoint?: string
  nodeId?: string
  domains?: string[]
}

export class GatewayRpcServer extends RpcTarget {
  private updateCallback: ConfigUpdateCallback
  private readonly logger: ServiceTelemetry['logger']
  private authClient?: RpcStub<AuthServiceApi>
  private nodeId: string
  private domains: string[]

  constructor(
    updateCallback: ConfigUpdateCallback,
    telemetry: ServiceTelemetry = TelemetryBuilder.noop('gateway'),
    options: GatewayRpcServerOptions = {}
  ) {
    super()
    this.updateCallback = updateCallback
    this.logger = telemetry.logger.getChild('rpc')
    this.nodeId = options.nodeId || 'unknown'
    this.domains = options.domains || []
    if (options.authEndpoint) {
      this.authClient = newWebSocketRpcSession<AuthServiceApi>(options.authEndpoint)
    }
  }

  /**
   * Authentication only: verifies the JWT token is valid (signature, expiry, revocation).
   * Does NOT evaluate Cedar policies.
   *
   * Used at entry-point level (getConfigClient) to verify the caller has a valid token.
   */
  private async authenticateToken(
    token: string
  ): Promise<{ valid: true } | { valid: false; error: string }> {
    if (!this.authClient) {
      return { valid: true }
    }

    try {
      const result = await this.authClient.authenticate(token)
      if (!result.valid) {
        return { valid: false, error: `Authentication failed: ${result.error}` }
      }
      return { valid: true }
    } catch (error) {
      return { valid: false, error: `Authentication failed: ${error}` }
    }
  }

  /**
   * Authorization: evaluates Cedar policy for a specific action.
   * Verifies the token AND checks if the action is permitted.
   *
   * Used inside handler methods (updateConfig) to enforce fine-grained access control.
   */
  private async authorizeToken(
    token: string,
    action: string
  ): Promise<{ valid: true } | { valid: false; error: string }> {
    if (!this.authClient) {
      return { valid: true }
    }

    try {
      const permissionsApi = await this.authClient.permissions(token)
      if ('error' in permissionsApi) {
        return { valid: false, error: `Invalid token: ${permissionsApi.error}` }
      }

      const result = await permissionsApi.authorizeAction({
        action,
        nodeContext: { nodeId: this.nodeId, domains: this.domains },
      })

      if (!result.success) {
        const detail = result.reason || result.reasons?.join(', ') || 'Permission denied'
        return {
          valid: false,
          error: `Authorization failed: ${result.errorType} - ${detail}`,
        }
      }

      if (!result.allowed) {
        return { valid: false, error: 'Permission denied' }
      }

      return { valid: true }
    } catch (error) {
      return { valid: false, error: `Authorization failed: ${error}` }
    }
  }

  /**
   * Returns the public API for the gateway RPC server.
   * This follows the orchestrator's progressive disclosure pattern:
   * callers first authenticate via getConfigClient(token), then interact
   * with the returned client's methods, each independently authorized.
   */
  publicApi(): GatewayPublicApi {
    return {
      getConfigClient: async (
        token: string
      ): Promise<{ success: true; client: ConfigClient } | { success: false; error: string }> => {
        // Authentication only: verify the token is valid (no policy evaluation)
        const authentication = await this.authenticateToken(token)
        if (!authentication.valid) {
          return { success: false, error: authentication.error }
        }

        return {
          success: true,
          client: {
            updateConfig: async (config: unknown): Promise<GatewayUpdateResult> => {
              this.logger.info`Config update received via RPC`

              // Authorization: evaluate Cedar policy for GATEWAY_UPDATE
              const check = await this.authorizeToken(token, 'GATEWAY_UPDATE')
              if (!check.valid) {
                return { success: false, error: check.error }
              }

              const result = GatewayConfigSchema.safeParse(config)
              if (!result.success) {
                this.logger.error`Invalid config received`
                return {
                  success: false,
                  error: 'Malformed configuration received and unable to parse',
                }
              }

              try {
                return await this.updateCallback(result.data)
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                this.logger.error`Config update failed: ${message}`
                return {
                  success: false,
                  error: `Failed to apply configuration: ${message}`,
                }
              }
            },
          },
        }
      },
    }
  }
}

export function createRpcHandler(rpcServer: GatewayPublicApi): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })
  return app
}
