import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { newRpcResponse } from '@hono/capnweb'
import { newWebSocketRpcSession, RpcTarget } from 'capnweb'
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
export interface AuthServicePermissionsHandlers {
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

export interface AuthServiceApi {
  /** Pure JWT verification - checks signature, expiry, and revocation only */
  authenticate(
    token: string
  ): Promise<{ valid: true; payload: Record<string, unknown> } | { valid: false; error: string }>
  /** Cedar policy evaluation - verifies token AND checks action permissions */
  permissions(token: string): Promise<AuthServicePermissionsHandlers | { error: string }>
}

export interface GatewayRpcServerOptions {
  authEndpoint?: string
  authClient?: AuthServiceApi
  nodeId: string
  domains: string[]
}

export class GatewayRpcServer extends RpcTarget {
  private updateCallback: ConfigUpdateCallback
  private readonly logger: ServiceTelemetry['logger']
  private authClient: AuthServiceApi
  private nodeId: string
  private domains: string[]

  constructor(
    updateCallback: ConfigUpdateCallback,
    telemetry: ServiceTelemetry = TelemetryBuilder.noop('gateway'),
    options: GatewayRpcServerOptions
  ) {
    super()
    this.updateCallback = updateCallback
    this.logger = telemetry.logger.getChild('rpc')
    this.nodeId = options.nodeId || 'unknown'
    this.domains = options.domains || []
    if (options.authClient) {
      this.authClient = options.authClient
    } else if (options.authEndpoint) {
      this.authClient = newWebSocketRpcSession<AuthServiceApi>(options.authEndpoint)
    } else {
      throw new Error('Authentication failed: provide authEndpoint or authClient')
    }
  }

  // The method exposed to RPC clients
  async updateConfig(config: unknown): Promise<GatewayUpdateResult> {
    this.logger.info`Config update received via RPC`
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
  }
}

export function createRpcHandler(rpcServer: GatewayRpcServer): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })
  return app
}
