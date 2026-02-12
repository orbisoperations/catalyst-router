import { z } from 'zod'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { DataChannelDefinitionSchema } from '@catalyst/routing'
import type { SnapshotCache } from '../xds/snapshot-cache.js'
import { buildXdsSnapshot } from '../xds/resources.js'

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
 * - `portAllocations`: explicit port→key map from the orchestrator's port allocator.
 *   When provided, these override the ports derived from route.envoyPort.
 *   This is needed for multi-hop: the local listener port (allocated by this node)
 *   may differ from route.envoyPort (the upstream peer's port, used for the remote cluster).
 */
export const RouteConfigSchema = z.object({
  local: z.array(DataChannelDefinitionSchema),
  internal: z.array(InternalRouteSchema),
  portAllocations: z.record(z.string(), z.number()).optional(),
})

export type RouteConfig = z.infer<typeof RouteConfigSchema>

export const UpdateResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
])

export type UpdateResult = z.infer<typeof UpdateResultSchema>

export interface EnvoyRpcServerOptions {
  telemetry?: ServiceTelemetry
  snapshotCache?: SnapshotCache
  bindAddress?: string
}

/**
 * Envoy RPC server.
 *
 * Receives route updates from the orchestrator, validates them, builds xDS
 * resources, and pushes snapshots to the cache for delivery to Envoy.
 */
export class EnvoyRpcServer extends RpcTarget {
  private readonly logger: ServiceTelemetry['logger']
  private readonly snapshotCache: SnapshotCache | undefined
  private readonly bindAddress: string
  private config: RouteConfig = { local: [], internal: [] }
  private versionCounter = 0

  constructor(options: EnvoyRpcServerOptions = {}) {
    super()
    const telemetry = options.telemetry ?? TelemetryBuilder.noop('envoy')
    this.logger = telemetry.logger.getChild('rpc')
    this.snapshotCache = options.snapshotCache
    this.bindAddress = options.bindAddress ?? '0.0.0.0'
  }

  /**
   * Update the current route config. Replaces all previous routes.
   *
   * Called by the orchestrator after port allocation. Each route includes
   * an `envoyPort` assigned by the orchestrator's port allocator.
   *
   * When a snapshot cache is configured, builds xDS resources (LDS + CDS)
   * from the route config and pushes a new snapshot to the cache.
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

    // Build and push xDS snapshot if a cache is configured
    if (this.snapshotCache) {
      // Use explicit portAllocations from orchestrator when available.
      // These separate local listener ports from upstream remote ports,
      // which is required for multi-hop transit routing.
      let portAllocations: Record<string, number>

      if (result.data.portAllocations) {
        portAllocations = { ...result.data.portAllocations }
      } else {
        // Backward compat: derive from route.envoyPort (2-node mode)
        portAllocations = {}
        for (const route of this.config.local) {
          if (route.envoyPort) {
            portAllocations[route.name] = route.envoyPort
          }
        }
        for (const route of this.config.internal) {
          if (route.envoyPort) {
            const egressKey = `egress_${route.name}_via_${route.peerName}`
            portAllocations[egressKey] = route.envoyPort
          }
        }
      }

      const snapshot = buildXdsSnapshot({
        local: this.config.local,
        internal: this.config.internal,
        portAllocations,
        bindAddress: this.bindAddress,
        version: String(++this.versionCounter),
      })

      this.snapshotCache.setSnapshot(snapshot)
      this.logger
        .info`xDS snapshot v${snapshot.version} pushed (${snapshot.listeners.length} listeners, ${snapshot.clusters.length} clusters)`
    }

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
