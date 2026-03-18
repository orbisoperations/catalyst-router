import {
  RoutingInformationBase,
  ActionQueue,
  Actions,
  InternalRouteView,
  type Action,
  type RouteTable,
  type PlanResult,
  type RoutePolicy,
  type InternalRoute,
  type PeerRecord,
  type DataChannelDefinition,
} from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import { getLogger, WideEvent } from '@catalyst/telemetry'
import type { PeerTransport, UpdateMessage } from './transport.js'
import type { OrchestratorConfig } from '../v1/types.js'

// ---------------------------------------------------------------------------
// Gateway client interface (for GraphQL gateway config sync)
// ---------------------------------------------------------------------------

export interface GatewayUpdateResult {
  success: boolean
  error?: string
}

export interface GatewayClient {
  updateConfig(config: {
    services: Array<{ name: string; url: string }>
  }): Promise<GatewayUpdateResult>
}

const logger = getLogger(['catalyst', 'orchestrator', 'bus'])

// v2-specific StateResult — uses v2 RouteTable (no `external` field)
export type StateResult =
  | { success: true; state: RouteTable; action: Action }
  | { success: false; error: string; state?: RouteTable }

export class OrchestratorBus {
  readonly rib: RoutingInformationBase
  private readonly queue: ActionQueue
  private readonly transport: PeerTransport
  private readonly routePolicy: RoutePolicy | undefined
  private readonly config: OrchestratorConfig
  private nodeToken: string | undefined
  private readonly gatewayClient: GatewayClient | undefined
  /**
   * Tracks the last time a keepalive was successfully sent to each peer.
   * Ephemeral (not persisted/journaled) — resets to 0 on restart.
   * Keyed by peer name.
   */
  private readonly lastKeepaliveSent = new Map<string, number>()

  constructor(opts: {
    config: OrchestratorConfig
    transport: PeerTransport
    journal?: ActionLog
    routePolicy?: RoutePolicy
    nodeToken?: string
    initialState?: RouteTable
    gatewayClient?: GatewayClient
  }) {
    this.config = opts.config
    this.transport = opts.transport
    this.routePolicy = opts.routePolicy
    this.nodeToken = opts.nodeToken
    this.gatewayClient = opts.gatewayClient
    this.queue = new ActionQueue()
    this.rib = new RoutingInformationBase({
      nodeId: opts.config.node.name,
      journal: opts.journal,
      initialState: opts.initialState,
    })
  }

  get state(): RouteTable {
    return this.rib.state
  }

  /** Read-only snapshot of the route table (deep clone). */
  getStateSnapshot(): RouteTable {
    return structuredClone(this.rib.state)
  }

  setNodeToken(token: string): void {
    this.nodeToken = token
  }

  async dispatch(action: Action): Promise<StateResult> {
    return this.queue.enqueue(async () => {
      const event = new WideEvent('orchestrator.action', logger)
      event.set({
        'catalyst.orchestrator.action.type': action.action,
        'catalyst.orchestrator.node.name': this.config.node.name,
      })

      const plan = this.rib.plan(action, this.rib.state)

      if (!this.rib.stateChanged(plan)) {
        // Tick with no expired peers: keepalives still need to fire.
        if (action.action === Actions.Tick) {
          await this.handleKeepalives(this.rib.state, action.data.now)
        }
        event.set('catalyst.orchestrator.action.state_changed', false)
        event.emit()
        return { success: false, error: 'No state change' }
      }

      const committed = this.rib.commit(plan, action)

      event.set({
        'catalyst.orchestrator.action.state_changed': true,
        'catalyst.orchestrator.route.change_count': plan.routeChanges.length,
        'catalyst.orchestrator.route.total':
          committed.local.routes.length + committed.internal.routes.length,
      })

      if (plan.routeChanges.length > 0) {
        const counts = { added: 0, removed: 0, modified: 0 }
        for (const c of plan.routeChanges) {
          if (c.type === 'added') counts.added++
          else if (c.type === 'removed') counts.removed++
          else counts.modified++
        }
        event.set({
          'catalyst.orchestrator.route.added': counts.added,
          'catalyst.orchestrator.route.removed': counts.removed,
          'catalyst.orchestrator.route.modified': counts.modified,
        })
        logger.info('Route table changed: +{added} -{removed} ~{modified} (trigger={trigger})', {
          'event.name': 'route.table.changed',
          'catalyst.orchestrator.route.added': counts.added,
          'catalyst.orchestrator.route.removed': counts.removed,
          'catalyst.orchestrator.route.modified': counts.modified,
          'catalyst.orchestrator.route.trigger': action.action,
          'catalyst.orchestrator.route.total':
            committed.local.routes.length + committed.internal.routes.length,
        })
      }

      await this.handlePostCommit(action, plan, committed)

      event.emit()
      return { success: true, state: committed, action }
    })
  }

  // ---------------------------------------------------------------------------
  // Post-commit side effects
  // ---------------------------------------------------------------------------

  private async handlePostCommit(
    action: Action,
    plan: PlanResult,
    committedState: RouteTable
  ): Promise<void> {
    // Use committedState snapshot — NEVER this.rib.state
    await this.handleBGPNotify(action, plan, committedState)
    // Sync GraphQL route list to gateway after route changes propagate.
    if (plan.routeChanges.length > 0) {
      await this.handleGraphqlGatewaySync(committedState)
    }
    // After BGP propagation, handle keepalive sends for Tick actions.
    // (The no-state-change Tick path in dispatch() handles the common case;
    // this handles Ticks that also caused peer expiry.)
    if (action.action === Actions.Tick) {
      await this.handleKeepalives(committedState, action.data.now)
    }
  }

  private async handleBGPNotify(
    action: Action,
    plan: PlanResult,
    state: RouteTable
  ): Promise<void> {
    const connectedPeers = state.internal.peers.filter((p) => p.connectionStatus === 'connected')

    // Initial sync: when a peer connects (outbound dial succeeded), send all
    // known routes so the session starts with a full table dump.
    if (action.action === Actions.InternalProtocolConnected) {
      const peerName = action.data.peerInfo.name
      const peer = connectedPeers.find((p) => p.name === peerName)
      if (peer !== undefined) {
        const event = new WideEvent('orchestrator.peer_sync', logger)
        event.set({
          'catalyst.orchestrator.peer.name': peerName,
          'catalyst.orchestrator.sync.type': 'full',
        })
        logger.info('Peer {peerName} connected, syncing full route table', {
          'event.name': 'peer.sync.started',
          'catalyst.orchestrator.peer.name': peerName,
        })
        await this.syncRoutesToPeer(peer, state)
        event.emit()
      }
      return
    }

    // Route changes: propagate deltas to every connected peer.
    if (plan.routeChanges.length === 0) return

    const event = new WideEvent('orchestrator.route_propagation', logger)
    event.set({
      'catalyst.orchestrator.peer.connected_count': connectedPeers.length,
      'catalyst.orchestrator.route.change_count': plan.routeChanges.length,
    })

    const promises = connectedPeers.map(async (peer) => {
      try {
        const updates = this.buildUpdatesForPeer(peer, plan, state)
        if (updates.length > 0) {
          await this.transport.sendUpdate(peer, { updates })
        }
      } catch (error) {
        logger.warn('Failed to send route updates to {peerName}', {
          'event.name': 'peer.sync.failed',
          'catalyst.orchestrator.peer.name': peer.name,
          error,
        })
        // Fire-and-forget: one peer failure must not affect others.
      }
    })

    await Promise.allSettled(promises)
  }

  // ---------------------------------------------------------------------------
  // GraphQL gateway sync (pushes graphql route list to gateway)
  // ---------------------------------------------------------------------------

  /**
   * Sync GraphQL routes to the gateway whenever routes change.
   * Filters all routes (local + internal) by protocol http:graphql or http:gql,
   * then pushes the full service list via the gateway client.
   * Fire-and-forget: errors are swallowed to avoid disrupting the dispatch pipeline.
   */
  private async handleGraphqlGatewaySync(state: RouteTable): Promise<void> {
    if (this.gatewayClient === undefined) return

    const graphqlRoutes = [...state.local.routes, ...state.internal.routes].filter(
      (r) => r.protocol === 'http:graphql' || r.protocol === 'http:gql'
    )

    if (graphqlRoutes.length === 0) return

    try {
      await this.gatewayClient.updateConfig({
        services: graphqlRoutes.map((r) => ({ name: r.name, url: r.endpoint! })),
      })
    } catch {
      // Fire-and-forget: gateway sync failure must not disrupt the bus.
    }
  }

  // ---------------------------------------------------------------------------
  // GraphQL gateway sync (pushes graphql route list to gateway)
  // ---------------------------------------------------------------------------

  /**
   * Sync GraphQL routes to the gateway whenever routes change.
   * Filters all routes (local + internal) by protocol http:graphql or http:gql,
   * then pushes the full service list via the gateway client.
   * Fire-and-forget: errors are swallowed to avoid disrupting the dispatch pipeline.
   */
  private async handleGraphqlGatewaySync(state: RouteTable): Promise<void> {
    if (this.gatewayClient === undefined) return

    const graphqlRoutes = [...state.local.routes, ...state.internal.routes].filter(
      (r) => r.protocol === 'http:graphql' || r.protocol === 'http:gql'
    )

    if (graphqlRoutes.length === 0) return

    try {
      await this.gatewayClient.updateConfig({
        services: graphqlRoutes.map((r) => ({ name: r.name, url: r.endpoint! })),
      })
    } catch {
      // Fire-and-forget: gateway sync failure must not disrupt the bus.
    }
  }

  // ---------------------------------------------------------------------------
  // Initial full-table sync (sent once when a peer connects)
  // ---------------------------------------------------------------------------

  private async syncRoutesToPeer(peer: PeerRecord, state: RouteTable): Promise<void> {
    const updates: UpdateMessage['updates'] = []

    // Advertise all local routes to the new peer.
    for (const route of state.local.routes) {
      updates.push({
        action: 'add',
        route,
        nodePath: [this.config.node.name],
        originNode: this.config.node.name,
      })
    }

    // Advertise internal routes the peer doesn't already know.
    for (const route of state.internal.routes) {
      // Exclude stale routes — they may no longer be valid.
      if (route.isStale === true) continue
      // Don't reflect a peer's own routes back at them.
      if (route.peer.name === peer.name) continue
      // Loop guard: don't advertise paths that already pass through this peer.
      if (route.nodePath.includes(peer.name)) continue

      // Apply route policy if configured.
      if (this.routePolicy !== undefined) {
        const allowed = this.routePolicy.canSend(peer, [route])
        if (allowed.length === 0) continue
      }

      updates.push({
        action: 'add',
        route: BusTransforms.toDataChannel(route),
        nodePath: [this.config.node.name, ...route.nodePath],
        originNode: route.originNode,
      })
    }

    if (updates.length === 0) {
      logger.info('No routes to sync to peer {peerName}', {
        'event.name': 'route.sync.empty',
        'catalyst.orchestrator.peer.name': peer.name,
      })
      return
    }

    try {
      await this.transport.sendUpdate(peer, { updates })
      logger.info('Synced {count} route(s) to peer {peerName}', {
        'event.name': 'route.sync.completed',
        'catalyst.orchestrator.peer.name': peer.name,
        'catalyst.orchestrator.route.count': updates.length,
      })
    } catch (error) {
      logger.warn('Initial route sync to {peerName} failed', {
        'event.name': 'peer.sync.initial_failed',
        'catalyst.orchestrator.peer.name': peer.name,
        error,
      })
      // Fire-and-forget: failed initial sync is not fatal; the peer can
      // request a refresh on reconnect.
    }
  }

  // ---------------------------------------------------------------------------
  // Keepalive sending (driven by Tick)
  // ---------------------------------------------------------------------------

  /**
   * Send keepalives to peers that need them.
   * A peer needs a keepalive if: connected, holdTime > 0, and the time since
   * we last sent (tracked ephemerally via lastKeepaliveSent) exceeds holdTime / 3.
   */
  private async handleKeepalives(state: RouteTable, now: number): Promise<void> {
    const promises = state.internal.peers
      .filter((p) => {
        if (p.connectionStatus !== 'connected' || p.holdTime <= 0) return false
        const lastSent = this.lastKeepaliveSent.get(p.name) ?? 0
        return now - lastSent > p.holdTime / 3
      })
      .map(async (peer) => {
        try {
          await this.transport.sendKeepalive(peer)
          this.lastKeepaliveSent.set(peer.name, now)
          logger.debug('Keepalive sent to {peerName}', {
            'event.name': 'peer.keepalive.sent',
            'catalyst.orchestrator.peer.name': peer.name,
          })
        } catch {
          // Fire-and-forget: keepalive failure is not fatal.
        }
      })

    await Promise.allSettled(promises)
  }

  // ---------------------------------------------------------------------------
  // Delta propagation (route change fan-out)
  // ---------------------------------------------------------------------------

  private buildUpdatesForPeer(
    peer: PeerRecord,
    plan: PlanResult,
    _state: RouteTable
  ): UpdateMessage['updates'] {
    const updates: UpdateMessage['updates'] = []

    for (const change of plan.routeChanges) {
      const route = change.route

      // Determine whether this is an internal route (has peer attribution).
      const isInternal = BusGuards.isInternalRoute(route)

      if (isInternal) {
        // Don't send back to the source peer.
        if (route.peer.name === peer.name) continue
        // Loop guard: don't advertise paths that already pass through this peer.
        if (route.nodePath.includes(peer.name)) continue

        // Apply route policy only for non-removal changes.
        if (change.type !== 'removed' && this.routePolicy !== undefined) {
          const allowed = this.routePolicy.canSend(peer, [route])
          if (allowed.length === 0) continue
        }

        updates.push({
          action: change.type === 'removed' ? 'remove' : 'add',
          route: BusTransforms.toDataChannel(route),
          nodePath: [this.config.node.name, ...route.nodePath],
          originNode: route.originNode,
        })
      } else {
        // Local route change — no loop-detection needed.
        updates.push({
          action: change.type === 'removed' ? 'remove' : 'add',
          route: BusTransforms.toDataChannel(route),
          nodePath: [this.config.node.name],
          originNode: this.config.node.name,
        })
      }
    }

    return updates
  }
}

// ---------------------------------------------------------------------------
// Helpers — grouped for discoverability
// ---------------------------------------------------------------------------

/** Type guards for route discrimination. */
export const BusGuards = {
  /** Narrows a RouteChange route to InternalRoute (has peer + nodePath). */
  isInternalRoute(route: DataChannelDefinition | InternalRoute): route is InternalRoute {
    return 'peer' in route && 'nodePath' in route && 'originNode' in route
  },
}

/** Data transforms for route serialization. */
export const BusTransforms = {
  /** Strips InternalRoute-only fields, returning only the DataChannelDefinition shape. */
  toDataChannel(route: DataChannelDefinition | InternalRoute): DataChannelDefinition {
    return new InternalRouteView(route as InternalRoute).toDataChannel()
  },
}
