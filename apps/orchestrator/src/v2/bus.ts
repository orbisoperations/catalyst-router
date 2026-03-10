import {
  RoutingInformationBase,
  ActionQueue,
  Actions,
  type Action,
  type RouteTable,
  type PlanResult,
  type RoutePolicy,
  type InternalRoute,
  type PeerRecord,
  type DataChannelDefinition,
} from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import { getLogger } from '@catalyst/telemetry'
import type { PeerTransport, UpdateMessage } from './transport.js'
import type { OrchestratorConfig } from '../v1/types.js'
import type { VideoNotifier } from './video-notifier.js'
import { buildStreamCatalog, hasMediaRouteChanges } from './video-notifier.js'

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
  private videoNotifier: VideoNotifier | undefined
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
    videoNotifier?: VideoNotifier
  }) {
    this.config = opts.config
    this.transport = opts.transport
    this.routePolicy = opts.routePolicy
    this.nodeToken = opts.nodeToken
    this.videoNotifier = opts.videoNotifier
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

  setNodeToken(token: string): void {
    this.nodeToken = token
  }

  setVideoNotifier(notifier: VideoNotifier | undefined): void {
    this.videoNotifier = notifier
  }

  async pushCurrentCatalog(): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.videoNotifier === undefined) return
      const catalog = buildStreamCatalog(this.config.node.name, this.rib.state)
      try {
        await this.videoNotifier.pushCatalog(catalog)
      } catch (error) {
        logger.warn`Video catalog push failed (initial sync): ${error}`
      }
    })
  }

  async dispatch(action: Action): Promise<StateResult> {
    return this.queue.enqueue(async () => {
      const plan = this.rib.plan(action, this.rib.state)

      if (!this.rib.stateChanged(plan)) {
        // Tick with no expired peers: keepalives still need to fire.
        if (action.action === Actions.Tick) {
          await this.handleKeepalives(this.rib.state, action.data.now)
        }
        return { success: false, error: 'No state change' }
      }

      const committed = this.rib.commit(plan, action)
      await this.handlePostCommit(action, plan, committed)

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
    await this.handleVideoNotify(plan, committedState)
    // After BGP propagation, handle keepalive sends for Tick actions.
    // (The no-state-change Tick path in dispatch() handles the common case;
    // this handles Ticks that also caused peer expiry.)
    if (action.action === Actions.Tick) {
      await this.handleKeepalives(committedState, action.data.now)
    }
  }

  private async handleVideoNotify(plan: PlanResult, committedState: RouteTable): Promise<void> {
    if (this.videoNotifier === undefined) return
    if (!hasMediaRouteChanges(plan.routeChanges)) return

    const catalog = buildStreamCatalog(this.config.node.name, committedState)
    try {
      await this.videoNotifier.pushCatalog(catalog)
    } catch (error) {
      logger.warn`Video catalog push failed: ${error}`
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
        await this.syncRoutesToPeer(peer, state)
      }
      return
    }

    // Route changes: propagate deltas to every connected peer.
    if (plan.routeChanges.length === 0) return

    const promises = connectedPeers.map(async (peer) => {
      try {
        const updates = this.buildUpdatesForPeer(peer, plan, state)
        if (updates.length > 0) {
          await this.transport.sendUpdate(peer, { updates })
        }
      } catch {
        // Fire-and-forget: one peer failure must not affect others.
      }
    })

    await Promise.allSettled(promises)
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

    if (updates.length === 0) return

    try {
      await this.transport.sendUpdate(peer, { updates })
    } catch {
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
    return {
      name: route.name,
      protocol: route.protocol,
      endpoint: route.endpoint,
      region: route.region,
      tags: route.tags,
      envoyPort: route.envoyPort,
      metadata: route.metadata,
    }
  },
}
