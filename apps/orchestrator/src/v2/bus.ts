import {
  RoutingInformationBase,
  ActionQueue,
  Actions,
  CloseCodes,
  type Action,
  type RouteTable,
  type PlanResult,
  type PortOperation,
  type RoutePolicy,
  type InternalRoute,
  type PeerRecord,
  type DataChannelDefinition,
} from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import type { WideEvent } from '@catalyst/telemetry'
import { getLogger, withWideEvent } from '@catalyst/telemetry'
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
// ---------------------------------------------------------------------------
// Envoy client interface (for Envoy config sync)
// ---------------------------------------------------------------------------

export interface EnvoyUpdateResult {
  success: boolean
  error?: string
}

export interface EnvoyClient {
  updateRoutes(config: {
    local: DataChannelDefinition[]
    internal: InternalRoute[]
    portAllocations?: Record<string, number>
  }): Promise<EnvoyUpdateResult>
}

/**
 * Port allocator interface — matches @catalyst/envoy-service's PortAllocator.
 * Defined here to avoid a hard dependency on the envoy package from the bus.
 */
export interface BusPortAllocator {
  allocate(channelName: string): { success: true; port: number } | { success: false; error: string }
  release(channelName: string): void
  getPort(channelName: string): number | undefined
  getAllocations(): ReadonlyMap<string, number>
}

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
  private readonly envoyClient: EnvoyClient | undefined
  private readonly portAllocator: BusPortAllocator | undefined
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
    envoyClient?: EnvoyClient
    portAllocator?: BusPortAllocator
  }) {
    this.config = opts.config
    this.transport = opts.transport
    this.routePolicy = opts.routePolicy
    this.nodeToken = opts.nodeToken
    this.gatewayClient = opts.gatewayClient
    this.envoyClient = opts.envoyClient
    this.portAllocator = opts.portAllocator
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
      return await withWideEvent('orchestrator.action', logger, async (event) => {
        event.set({
          'catalyst.orchestrator.action.type': action.action,
          'catalyst.orchestrator.node.name': this.config.node.name,
        })
        // Step 1: Validate — reject invalid actions before planning.
        if (action.action === Actions.LocalPeerCreate && !action.data.peerToken?.trim()) {
          return { success: false, error: 'peerToken is required when creating a peer' }
        }

        // Step 1b: Inbound route policy — filter received routes before planning.
        const filteredAction = this.applyInboundPolicy(action)
        if (filteredAction === undefined) {
          return { success: false, error: 'All routes rejected by inbound policy' }
        }

        // Step 2: Plan — pure state transition, no side effects.
        const ribPlan = this.rib.plan(filteredAction, this.rib.state)

        if (!this.rib.stateChanged(ribPlan)) {
          // Tick with no expired peers: keepalives still need to fire.
          if (action.action === Actions.Tick) {
            const ka = await this.handleKeepalives(this.rib.state, action.data.now)
            event.set({
              'catalyst.orchestrator.keepalive.needed': ka.needed,
              'catalyst.orchestrator.keepalive.sent': ka.sent,
            })
          }
          event.set('catalyst.orchestrator.action.state_changed', false)
          return { success: false, error: 'No state change' }
        }

        // Step 3: Port allocation — release/allocate ports, stamp on newState.
        //         Runs between plan and commit so committed state has ports.
        const plan = this.planPortAllocations(ribPlan)

        // Enrich dispatch event with port allocation summary.
        const portsAllocated = plan.portOps.filter((op) => op.type === 'allocate').length
        const portsReleased = plan.portOps.filter((op) => op.type === 'release').length
        if (portsAllocated > 0 || portsReleased > 0) {
          event.set({
            'catalyst.orchestrator.port.allocated': portsAllocated,
            'catalyst.orchestrator.port.released': portsReleased,
          })
        }

        // Step 4: Commit — apply state + journal.
        const committed = this.rib.commit(plan, action)

        // Step 5: Notify — propagate to peers, push to envoy/gateway.

        event.set({
          'catalyst.orchestrator.action.state_changed': true,
          'catalyst.orchestrator.route.change_count': plan.routeChanges.length,
          'catalyst.orchestrator.route.total':
            committed.local.routes.size + [...committed.internal.routes.values()].reduce((n, m) => n + m.size, 0),
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
              committed.local.routes.size + [...committed.internal.routes.values()].reduce((n, m) => n + m.size, 0),
          })
        }

        await this.handlePostCommit(action, plan, committed, event)

        return { success: true, state: committed, action }
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Inbound route policy (filters received routes before planning)
  // ---------------------------------------------------------------------------

  /**
   * Apply inbound route policy to InternalProtocolUpdate actions.
   * Returns the action with filtered routes, or undefined if all routes
   * were rejected (caller should short-circuit with no state change).
   * Non-update actions pass through unchanged.
   */
  private applyInboundPolicy(action: Action): Action | undefined {
    if (action.action !== Actions.InternalProtocolUpdate) return action
    if (this.routePolicy === undefined) return action

    const peer = this.rib.state.internal.peers.get(action.data.peerInfo.name)
    if (peer === undefined) return action

    const updates = action.data.update.updates
    const routes = updates.map((u) => u.route)
    const allowed = this.routePolicy.canReceive(peer, routes)
    const allowedNames = new Set(allowed.map((r) => r.name))

    const filteredUpdates = updates.filter((u) => allowedNames.has(u.route.name))
    if (filteredUpdates.length === 0) return undefined

    return {
      ...action,
      data: {
        ...action.data,
        update: { updates: filteredUpdates },
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Post-commit side effects
  // ---------------------------------------------------------------------------

  private async handlePostCommit(
    action: Action,
    plan: PlanResult,
    committedState: RouteTable,
    event: WideEvent
  ): Promise<void> {
    // Use committedState snapshot — NEVER this.rib.state
    await this.handleBGPNotify(action, plan, committedState)
    // Sync GraphQL route list to gateway after route changes propagate.
    if (plan.routeChanges.length > 0) {
      await this.handleGraphqlGatewaySync(committedState)
    }
    // Execute port operations and push config to envoy.
    if (plan.routeChanges.length > 0 || plan.portOps.length > 0) {
      await this.handleEnvoySync(plan, committedState)
    }
    // After BGP propagation, handle keepalive sends for Tick actions.
    // (The no-state-change Tick path in dispatch() handles the common case;
    // this handles Ticks that also caused peer expiry.)
    if (action.action === Actions.Tick) {
      const ka = await this.handleKeepalives(committedState, action.data.now)
      event.set({
        'catalyst.orchestrator.keepalive.needed': ka.needed,
        'catalyst.orchestrator.keepalive.sent': ka.sent,
      })
    }
  }

  private async handleBGPNotify(
    action: Action,
    plan: PlanResult,
    state: RouteTable
  ): Promise<void> {
    const connectedPeers = [...state.internal.peers.values()].filter(
      (p) => p.connectionStatus === 'connected'
    )

    // Initial sync: when a peer connects (outbound dial succeeded), send all
    // known routes so the session starts with a full table dump.
    if (action.action === Actions.InternalProtocolConnected) {
      const peerName = action.data.peerInfo.name
      const peer = connectedPeers.find((p) => p.name === peerName)
      if (peer !== undefined) {
        await withWideEvent('orchestrator.peer_sync', logger, async (event) => {
          event.set({
            'catalyst.orchestrator.peer.name': peerName,
            'catalyst.orchestrator.sync.type': 'full',
          })
          logger.info('Peer {peerName} connected, syncing full route table', {
            'event.name': 'peer.sync.started',
            'catalyst.orchestrator.peer.name': peerName,
          })
          await this.syncRoutesToPeer(peer, state)
        })
      }
      return
    }

    // Close notification: when a peer is deleted, notify it before withdrawals.
    // Uses prevState because the peer is already removed from committed state.
    if (action.action === Actions.LocalPeerDelete) {
      const deletedPeer = plan.prevState.internal.peers.get(action.data.name)
      if (deletedPeer !== undefined) {
        try {
          await this.transport.closePeer(deletedPeer, CloseCodes.NORMAL, 'Peer removed')
        } catch {
          // Fire-and-forget: close failure must not block withdrawal propagation.
        }
      }
      // Fall through to route-change fan-out below
    }

    // Route changes: propagate deltas to every connected peer.
    if (plan.routeChanges.length === 0) return

    await withWideEvent('orchestrator.route_propagation', logger, async (event) => {
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
    })
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
    const client = this.gatewayClient
    if (client === undefined) return

    const allRoutes = [
      ...state.local.routes.values(),
      ...[...state.internal.routes.values()].flatMap((m) => [...m.values()]),
    ]
    const graphqlRoutes = allRoutes.filter(
      (r) => r.protocol === 'http:graphql' || r.protocol === 'http:gql'
    )

    if (graphqlRoutes.length === 0) return

    try {
      await withWideEvent('orchestrator.gateway_sync', logger, async (event) => {
        event.set('catalyst.orchestrator.gateway.route_count', graphqlRoutes.length)
        await client.updateConfig({
          services: graphqlRoutes.map((r) => ({ name: r.name, url: r.endpoint! })),
        })
      })
    } catch {
      // Fire-and-forget: gateway sync failure must not disrupt the bus.
    }
  }

  // ---------------------------------------------------------------------------
  // Port allocation planning (runs between plan and commit)
  // ---------------------------------------------------------------------------

  /**
   * Enrich a RIB plan with port allocations. Returns a new PlanResult whose
   * newState has envoyPort stamped on every route and whose portOps contain
   * the full audit trail of allocations and releases.
   *
   * Phases (each clearly separated for traceability):
   *   Phase 1 — Release: free ports for removed routes and RIB release ops
   *   Phase 2 — Allocate local: assign ingress ports to local routes
   *   Phase 3 — Allocate egress: assign egress ports to internal routes
   *   Phase 4 — Stamp: build new state with ports applied
   *
   * No-ops gracefully when no port allocator is configured.
   */
  private planPortAllocations(plan: PlanResult): PlanResult {
    if (this.portAllocator === undefined) return plan

    const portOps: PortOperation[] = []

    // Phase 1 — Release: free ports for removed routes.
    for (const change of plan.routeChanges) {
      if (change.type !== 'removed') continue
      const route = change.route

      // Release local route port.
      const localPort = this.portAllocator.getPort(route.name)
      if (localPort !== undefined) {
        this.portAllocator.release(route.name)
        portOps.push({ type: 'release', routeKey: route.name, port: localPort })
      }

      // Release egress port if it was an internal route.
      if (BusGuards.isInternalRoute(route)) {
        const egressKey = `egress_${route.name}_via_${route.peer.name}`
        const egressPort = this.portAllocator.getPort(egressKey)
        if (egressPort !== undefined) {
          this.portAllocator.release(egressKey)
          portOps.push({ type: 'release', routeKey: egressKey, port: egressPort })
        }
      }
    }

    // Also honour RIB-generated release ops (routes with envoyPort already stamped).
    for (const op of plan.portOps) {
      if (op.type === 'release') {
        this.portAllocator.release(op.routeKey)
        portOps.push(op)
      }
    }

    // Phase 2 — Allocate local: assign ingress ports to local routes.
    //          Builds a lookup map for Phase 5 (routeChange stamping).
    const localPortMap = new Map<string, number>()
    const localRoutes = new Map<string, DataChannelDefinition>()
    for (const [key, route] of plan.newState.local.routes) {
      if (route.envoyPort) {
        localRoutes.set(key, route)
        continue
      }
      const result = this.portAllocator!.allocate(route.name)
      if (!result.success) {
        localRoutes.set(key, route)
        continue
      }
      portOps.push({ type: 'allocate', routeKey: route.name, port: result.port })
      localPortMap.set(route.name, result.port)
      localRoutes.set(key, { ...route, envoyPort: result.port })
    }

    // Phase 3 — Allocate egress: assign egress ports to internal routes.
    const egressPortMap = new Map<string, number>()
    const internalRoutes = new Map<string, Map<string, InternalRoute>>()
    for (const [peerName, innerMap] of plan.newState.internal.routes) {
      const newInner = new Map<string, InternalRoute>()
      for (const [irKey, route] of innerMap) {
        const egressKey = `egress_${route.name}_via_${route.peer.name}`
        const result = this.portAllocator!.allocate(egressKey)
        if (!result.success) {
          newInner.set(irKey, route)
          continue
        }
        if (route.envoyPort !== result.port) {
          portOps.push({ type: 'allocate', routeKey: egressKey, port: result.port })
        }
        egressPortMap.set(egressKey, result.port)
        newInner.set(irKey, { ...route, envoyPort: result.port })
      }
      internalRoutes.set(peerName, newInner)
    }

    // Phase 4 — Stamp: build enriched state with ports applied.
    const newState: RouteTable = {
      local: { routes: localRoutes },
      internal: {
        ...plan.newState.internal,
        routes: internalRoutes,
      },
    }

    // Phase 5 — Sync routeChanges: stamp ports on added/updated route changes
    //           so downstream consumers (buildUpdatesForPeer) see correct ports.
    const routeChanges = plan.routeChanges.map((change) => {
      if (change.type === 'removed') return change
      const route = change.route
      if (BusGuards.isInternalRoute(route)) {
        const egressKey = `egress_${route.name}_via_${route.peer.name}`
        const port = egressPortMap.get(egressKey)
        if (port !== undefined && route.envoyPort !== port) {
          return { ...change, route: { ...route, envoyPort: port } }
        }
      } else {
        const port = localPortMap.get(route.name)
        if (port !== undefined && !route.envoyPort) {
          return { ...change, route: { ...route, envoyPort: port } }
        }
      }
      return change
    })

    return { ...plan, newState, portOps, routeChanges }
  }

  // ---------------------------------------------------------------------------
  // Envoy config sync (pushes committed state to envoy service)
  // ---------------------------------------------------------------------------

  /**
   * Push the full route config to the envoy service.
   * Port allocation is already done in planPortAllocations — this method
   * only pushes the committed (port-stamped) state.
   *
   * Fire-and-forget: errors are swallowed to avoid disrupting the dispatch pipeline.
   */
  private async handleEnvoySync(_plan: PlanResult, state: RouteTable): Promise<void> {
    const client = this.envoyClient
    if (client === undefined) return

    try {
      await withWideEvent('orchestrator.envoy_sync', logger, async (event) => {
        const allInternalRoutes = [...state.internal.routes.values()].flatMap((m) => [...m.values()])
        event.set({
          'catalyst.orchestrator.envoy.local_count': state.local.routes.size,
          'catalyst.orchestrator.envoy.internal_count': allInternalRoutes.length,
        })
        await client.updateRoutes({
          local: [...state.local.routes.values()],
          internal: allInternalRoutes,
          portAllocations: this.portAllocator
            ? Object.fromEntries(this.portAllocator.getAllocations())
            : undefined,
        })
      })
    } catch {
      // Fire-and-forget: envoy sync failure must not disrupt the bus.
    }
  }

  // ---------------------------------------------------------------------------
  // Initial full-table sync (sent once when a peer connects)
  // ---------------------------------------------------------------------------

  private async syncRoutesToPeer(peer: PeerRecord, state: RouteTable): Promise<void> {
    const updates: UpdateMessage['updates'] = []

    const localEnvoyAddress = this.config.node.envoyAddress

    // Advertise all local routes to the new peer.
    for (const route of state.local.routes.values()) {
      updates.push({
        action: 'add',
        route: BusTransforms.toDataChannel(route, { envoyAddress: localEnvoyAddress }),
        nodePath: [this.config.node.name],
        originNode: this.config.node.name,
      })
    }

    // Advertise internal routes the peer doesn't already know.
    for (const innerMap of state.internal.routes.values()) {
      for (const route of innerMap.values()) {
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

        // Multi-hop: envoyPort is already stamped by planPortAllocations.
        // Rewrite envoyAddress to this node's envoy so downstream peers route through us.
        updates.push({
          action: 'add',
          route: BusTransforms.toDataChannel(route, { envoyAddress: localEnvoyAddress }),
          nodePath: [this.config.node.name, ...route.nodePath],
          originNode: route.originNode,
        })
      }
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
  private async handleKeepalives(
    state: RouteTable,
    now: number
  ): Promise<{ needed: number; sent: number }> {
    let sent = 0
    const peersNeeding = [...state.internal.peers.values()].filter((p) => {
      if (p.connectionStatus !== 'connected' || p.holdTime <= 0) return false
      const lastSent = this.lastKeepaliveSent.get(p.name) ?? 0
      return now - lastSent > p.holdTime / 3
    })

    const promises = peersNeeding.map(async (peer) => {
      try {
        await this.transport.sendKeepalive(peer)
        this.lastKeepaliveSent.set(peer.name, now)
        sent++
        logger.debug('Keepalive sent to {peerName}', {
          'event.name': 'peer.keepalive.sent',
          'catalyst.orchestrator.peer.name': peer.name,
        })
      } catch {
        // Fire-and-forget: keepalive failure is not fatal.
      }
    })

    await Promise.allSettled(promises)
    return { needed: peersNeeding.length, sent }
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
    const localEnvoyAddress = this.config.node.envoyAddress

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

        // Multi-hop: envoyPort is already stamped by planPortAllocations.
        // Rewrite envoyAddress to this node's envoy so downstream peers route through us.
        updates.push({
          action: change.type === 'removed' ? 'remove' : 'add',
          route: BusTransforms.toDataChannel(route, { envoyAddress: localEnvoyAddress }),
          nodePath: [this.config.node.name, ...route.nodePath],
          originNode: route.originNode,
        })
      } else {
        // Local route change — no loop-detection needed.
        updates.push({
          action: change.type === 'removed' ? 'remove' : 'add',
          route: BusTransforms.toDataChannel(route, { envoyAddress: localEnvoyAddress }),
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
  /**
   * Strips InternalRoute-only fields, returning only the DataChannelDefinition shape.
   * envoyPort comes from the route (stamped by planPortAllocations).
   * envoyAddress can be overridden to this node's address for multi-hop forwarding.
   */
  toDataChannel(
    route: DataChannelDefinition | InternalRoute,
    overrides?: { envoyAddress?: string }
  ): DataChannelDefinition {
    return {
      name: route.name,
      protocol: route.protocol,
      endpoint: route.endpoint,
      region: route.region,
      tags: route.tags,
      envoyPort: route.envoyPort,
      envoyAddress: overrides?.envoyAddress ?? route.envoyAddress,
      healthStatus: route.healthStatus,
      responseTimeMs: route.responseTimeMs,
      lastCheckedAt: route.lastCheckedAt,
    }
  },
}
