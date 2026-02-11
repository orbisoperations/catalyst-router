import { z } from 'zod'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { DataChannelDefinitionSchema } from '@catalyst/routing'

/**
 * Internal route entry — a data channel on a remote peer, with peer metadata.
 */
export const InternalRouteSchema = DataChannelDefinitionSchema.extend({
  peer: z.object({ name: z.string(), envoyAddress: z.string().optional() }),
  peerName: z.string(),
  nodePath: z.array(z.string()),
})

/**
 * Route config from the orchestrator. Ports are already assigned.
 *
 * - `local`: data channels on this node
 * - `internal`: data channels on remote peers, routed through envoy
 */
export const RouteConfigSchema = z.object({
  local: z.array(DataChannelDefinitionSchema),
  internal: z.array(InternalRouteSchema),
})

export type RouteConfig = z.infer<typeof RouteConfigSchema>

export const UpdateResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type UpdateResult = z.infer<typeof UpdateResultSchema>

/**
 * Envoy RPC server.
 *
 * Receives route updates from the orchestrator and stores them.
 * Phase 3 scope: validate + store only. xDS snapshot building is Phase 4.
 */
export class EnvoyRpcServer extends RpcTarget {
  private readonly logger: ServiceTelemetry['logger']
  private config: RouteConfig = { local: [], internal: [] }

  constructor(telemetry: ServiceTelemetry = TelemetryBuilder.noop('envoy')) {
    super()
    this.logger = telemetry.logger.getChild('rpc')
  }

  /**
   * Update the current route config. Replaces all previous routes.
   *
   * Called by the orchestrator after port allocation. Each route includes
   * an `envoyPort` assigned by the orchestrator's port allocator.
   */
  async updateRoutes(config: unknown): Promise<UpdateResult> {
    this.logger.info`Route update received via RPC`

    const result = RouteConfigSchema.safeParse(config)
    if (!result.success) {
      this.logger.error`Malformed route config received`
      return {
        success: false,
        error: 'Malformed route configuration received and unable to parse',
      }
    }

    this.config = result.data
    const total = this.config.local.length + this.config.internal.length
    this.logger
      .info`Stored ${total} route(s) (${this.config.local.length} local, ${this.config.internal.length} internal)`

    return { success: true }
  }

  /**
   * Return the current route config.
   */
  async getRoutes(): Promise<RouteConfig> {
    return this.config
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
