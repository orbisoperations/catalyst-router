import { z } from 'zod'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { DataChannelDefinitionSchema } from '@catalyst/routing'
import type { DataChannelDefinition } from '@catalyst/routing'

/**
 * Schema for the routes array passed to updateRoutes().
 * Each entry is a DataChannelDefinition (name, protocol, endpoint, envoyPort, etc.).
 */
export const EnvoyRoutesSchema = z.array(DataChannelDefinitionSchema)

export const EnvoyUpdateResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type EnvoyUpdateResult = z.infer<typeof EnvoyUpdateResultSchema>

/**
 * Envoy RPC server.
 *
 * Receives route updates from the orchestrator and stores them.
 * Phase 3 scope: validate + store only. xDS snapshot building is Phase 4.
 */
export class EnvoyRpcServer extends RpcTarget {
  private readonly logger: ServiceTelemetry['logger']
  private routes: DataChannelDefinition[] = []

  constructor(telemetry: ServiceTelemetry = TelemetryBuilder.noop('envoy')) {
    super()
    this.logger = telemetry.logger.getChild('rpc')
  }

  /**
   * Update the current route set. Replaces all previous routes.
   *
   * Called by the orchestrator after port allocation. Each route includes
   * an `envoyPort` assigned by the orchestrator's port allocator.
   */
  async updateRoutes(routes: unknown): Promise<EnvoyUpdateResult> {
    this.logger.info`Route update received via RPC`

    const result = EnvoyRoutesSchema.safeParse(routes)
    if (!result.success) {
      this.logger.error`Malformed routes received`
      return {
        success: false,
        error: 'Malformed route configuration received and unable to parse',
      }
    }

    this.routes = result.data
    this.logger.info`Stored ${this.routes.length} route(s)`

    return { success: true }
  }

  /**
   * Return the current route set.
   */
  async getRoutes(): Promise<DataChannelDefinition[]> {
    return this.routes
  }
}

/**
 * Create a Hono app with the RPC WebSocket upgrade endpoint.
 */
export function createRpcHandler(rpcServer: EnvoyRpcServer): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })
  return app
}
