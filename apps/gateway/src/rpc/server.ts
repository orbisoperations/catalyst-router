import { z } from 'zod'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'

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

export class GatewayRpcServer extends RpcTarget {
  private updateCallback: ConfigUpdateCallback
  private readonly logger: ServiceTelemetry['logger']

  constructor(
    updateCallback: ConfigUpdateCallback,
    telemetry: ServiceTelemetry = TelemetryBuilder.noop('gateway')
  ) {
    super()
    this.updateCallback = updateCallback
    this.logger = telemetry.logger.getChild('rpc')
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
