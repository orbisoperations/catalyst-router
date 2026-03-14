import { z } from 'zod'
import { Hono } from 'hono'
import { getUpgradeWebSocket } from '@catalyst/service'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { TelemetryBuilder, WideEvent } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { DataChannelDefinitionSchema } from '@catalyst/routing'
import type { SnapshotCache, XdsSnapshot } from '../xds/snapshot-cache.js'
import { buildXdsSnapshot } from '../xds/resources.js'

/**
 * Internal route entry — a data channel on a remote peer, with peer metadata.
 */
export const InternalRouteSchema = DataChannelDefinitionSchema.extend({
  peer: z.object({ name: z.string(), envoyAddress: z.string().optional() }),
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
  portAllocations: z.record(z.string(), z.number().int().min(1).max(65535)).optional(),
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
  private previousSnapshot: XdsSnapshot | undefined

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
    const event = new WideEvent('envoy.route_update', this.logger)
    this.logger.info('Route update received via RPC', {
      'event.name': 'envoy.route_update.received',
    })

    const result = RouteConfigSchema.safeParse(config)
    if (!result.success) {
      this.logger.error('Malformed route config received', {
        'event.name': 'envoy.route_update.invalid',
      })
      event.setError(new Error('Malformed route configuration'))
      event.emit()
      return {
        success: false,
        error: 'Malformed route configuration received and unable to parse',
      }
    }

    this.config = result.data
    const total = this.config.local.length + this.config.internal.length
    this.logger.info('Stored {total} route(s) ({localCount} local, {internalCount} internal)', {
      'event.name': 'envoy.routes.stored',
      total,
      localCount: this.config.local.length,
      internalCount: this.config.internal.length,
    })
    event.set({
      'envoy.route_count': total,
      'envoy.local_count': this.config.local.length,
      'envoy.internal_count': this.config.internal.length,
    })

    // Build and push xDS snapshot if a cache is configured
    if (this.snapshotCache) {
      // Use explicit portAllocations from orchestrator when available.
      // These separate local listener ports from upstream remote ports,
      // which is required for multi-hop transit routing.
      let portAllocations: Record<string, number>

      if (result.data.portAllocations) {
        portAllocations = { ...result.data.portAllocations }
      } else {
        // Backward compat: derive from route.envoyPort (2-node mode).
        // This conflates local listener ports with remote upstream ports,
        // which only works when ports are symmetric (direct 2-node links).
        // Multi-hop routing requires explicit portAllocations.
        this.logger.warn(
          'No portAllocations in route config — using legacy envoyPort derivation (2-node only)',
          { 'event.name': 'envoy.port.legacy_derivation' }
        )
        portAllocations = {}
        for (const route of this.config.local) {
          if (route.envoyPort) {
            portAllocations[route.name] = route.envoyPort
          }
        }
        for (const route of this.config.internal) {
          if (route.envoyPort) {
            const egressKey = `egress_${route.name}_via_${route.peer.name}`
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

      // Log config diff from previous snapshot
      if (this.previousSnapshot) {
        const prevClusterNames = new Set(this.previousSnapshot.clusters.map((c) => c.name))
        const newClusterNames = new Set(snapshot.clusters.map((c) => c.name))
        const clustersAdded = [...newClusterNames].filter((n) => !prevClusterNames.has(n)).length
        const clustersRemoved = [...prevClusterNames].filter((n) => !newClusterNames.has(n)).length

        this.logger.info('xDS config diff: clusters +{added} -{removed}', {
          'event.name': 'envoy.config.diff',
          'xds.clusters_added': clustersAdded,
          'xds.clusters_removed': clustersRemoved,
          'xds.version': snapshot.version,
          added: clustersAdded,
          removed: clustersRemoved,
        })
      }

      this.snapshotCache.setSnapshot(snapshot)
      this.previousSnapshot = snapshot
      this.logger.info(
        'xDS snapshot v{version} pushed ({listenerCount} listeners, {clusterCount} clusters)',
        {
          'event.name': 'xds.snapshot.pushed',
          'xds.version': snapshot.version,
          'xds.listener_count': snapshot.listeners.length,
          'xds.cluster_count': snapshot.clusters.length,
          version: snapshot.version,
          listenerCount: snapshot.listeners.length,
          clusterCount: snapshot.clusters.length,
        }
      )
      event.set({
        'xds.snapshot_version': snapshot.version,
        'xds.listener_count': snapshot.listeners.length,
        'xds.cluster_count': snapshot.clusters.length,
      })
    }

    event.emit()
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
      upgradeWebSocket: getUpgradeWebSocket(c),
    })
  })
  return app
}
