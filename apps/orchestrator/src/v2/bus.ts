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
import { getLogger, WideEvent } from '@catalyst/telemetry'
import type { PeerTransport, UpdateMessage } from './transport.js'
import type { OrchestratorConfig } from '../v1/types.js'

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
  }) {
    this.config = opts.config
    this.transport = opts.transport
    this.routePolicy = opts.routePolicy
    this.nodeToken = opts.nodeToken
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

      try {
        const plan = this.rib.plan(action, this.rib.state)

        if (!this.rib.stateChanged(plan)) {
          if (action.action === Actions.Tick) {
            await this.handleKeepalives(this.rib.state, action.data.now)
          }
          event.set('catalyst.orchestrator.action.state_changed', false)
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
            'catalyst.orchestrator.route.trigger': action.action,
          })
        }

        await this.handlePostCommit(action, plan, committed)

        return { success: true, state: committed, action }
      } catch (error) {
        event.setError(error)
        throw error
      } finally {
        event.emit()
      }
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
        try {
          const result = await this.syncRoutesToPeer(peer, state)
          event.set('catalyst.orchestrator.sync.route_count', result.routeCount)
        } catch (error) {
          event.setError(error)
        } finally {
          event.emit()
        }
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

    const results = await Promise.allSettled(
      connectedPeers.map(async (peer) => {
        const updates = this.buildUpdatesForPeer(peer, plan, state)
        if (updates.length > 0) {
          await this.transport.sendUpdate(peer, { updates })
        }
      })
    )

    const failedPeers = results
      .map((r, i) => (r.status === 'rejected' ? connectedPeers[i].name : null))
      .filter(Boolean) as string[]
    if (failedPeers.length > 0) {
      event.set({
        'catalyst.orchestrator.peer.failed_count': failedPeers.length,
        'catalyst.orchestrator.peer.failed_peers': failedPeers,
        'catalyst.event.outcome':
          failedPeers.length === connectedPeers.length ? 'failure' : 'partial_failure',
      })
    }

    event.emit()
  }

  // ---------------------------------------------------------------------------
  // Initial full-table sync (sent once when a peer connects)
  // ---------------------------------------------------------------------------

  /**
   * Send all known routes to a newly connected peer.
   * Failures are non-fatal — the peer can request a full refresh on reconnect.
   */
  private async syncRoutesToPeer(
    peer: PeerRecord,
    state: RouteTable
  ): Promise<{ routeCount: number }> {
    const updates: UpdateMessage['updates'] = []

    for (const route of state.local.routes) {
      updates.push({
        action: 'add',
        route,
        nodePath: [this.config.node.name],
        originNode: this.config.node.name,
      })
    }

    for (const route of state.internal.routes) {
      if (route.isStale === true) continue
      if (route.peer.name === peer.name) continue
      if (route.nodePath.includes(peer.name)) continue

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
      return { routeCount: 0 }
    }

    await this.transport.sendUpdate(peer, { updates })
    return { routeCount: updates.length }
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
