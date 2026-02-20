import {
  Actions,
  newRouteTable,
  type Action,
  type DataChannelDefinition,
  type InternalRoute,
  type LocRibEntry,
  type PeerRecord,
  type RouteTable,
} from '@catalyst/routing'
import { getLogger } from '@catalyst/telemetry'
import type { OrchestratorConfig } from './types.js'
import type { PortAllocator } from '@catalyst/envoy-service'
import type { Propagation } from './peer-transport.js'

export interface PortOperation {
  type: 'allocate' | 'release'
  key: string
}

export interface Plan {
  success: true
  action: Action
  prevState: RouteTable
  newState: RouteTable
  portOperations: PortOperation[]
  routeMetadata: Map<string, LocRibEntry>
}

export interface PlanFailure {
  success: false
  error: string
}

export type PlanResult = Plan | PlanFailure

export interface CommitResult {
  action: Action
  prevState: RouteTable
  newState: RouteTable
  propagations: Propagation[]
  portOperations: PortOperation[]
  routesChanged: boolean
}

export class RoutingInformationBase {
  private readonly logger = getLogger(['catalyst', 'rib'])
  private state: RouteTable
  private routeMetadata: Map<string, LocRibEntry> = new Map()

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly portAllocator?: PortAllocator,
    initialState?: RouteTable
  ) {
    this.state = initialState ?? newRouteTable()
  }

  getState(): RouteTable {
    return this.state
  }

  getRouteMetadata(): Map<string, LocRibEntry> {
    return this.routeMetadata
  }

  /**
   * Compute the new state and port operations for an action.
   * Pure — does NOT mutate this.state or the PortAllocator. Synchronous.
   *
   * Returns declarative port operations (allocate/release) that commit()
   * will execute. Propagations are computed in commit() after ports are
   * resolved, since propagation messages need actual port values.
   */
  plan(action: Action): PlanResult {
    const prevState = this.state
    const stateResult = this.computeNewState(action, prevState)

    if (!stateResult.success) {
      return { success: false, error: stateResult.error }
    }

    const newState = stateResult.state
    const portOperations = this.computePortOps(action, newState, prevState)
    const routeMetadata = this.computeRouteMetadata(newState)

    return {
      success: true,
      action,
      prevState,
      newState,
      portOperations,
      routeMetadata,
    }
  }

  /**
   * Execute the plan: allocate ports, stamp them onto state, compute
   * propagations, and apply the final state. The caller is responsible
   * for executing propagations via transport (typically fire-and-forget
   * to avoid cross-node deadlocks in the ActionQueue).
   */
  commit(plan: Plan): CommitResult {
    const prevState = this.state

    // 1. Execute port operations on the allocator
    this.executePortOps(plan.portOperations)

    // 2. Stamp resolved port values onto routes in the new state
    let newState = this.stampPortsOnState(plan.newState)

    // 3. Compute propagations (now has correct port values from allocator)
    const propagations = this.computePropagations(plan.action, newState, plan.prevState)

    // 4. Update lastSent for peers that will receive propagations
    const sentPeerNames = new Set(
      propagations
        .filter((p) => p.type === 'update' || p.type === 'keepalive')
        .map((p) => p.peer.name)
    )
    if (sentPeerNames.size > 0) {
      const now = Date.now()
      newState = {
        ...newState,
        internal: {
          ...newState.internal,
          peers: newState.internal.peers.map((p) =>
            sentPeerNames.has(p.name) ? { ...p, lastSent: now } : p
          ),
        },
      }
    }

    // 5. Apply state
    this.state = newState
    this.routeMetadata = plan.routeMetadata

    const routesChanged =
      prevState.local.routes !== plan.newState.local.routes ||
      prevState.internal.routes !== plan.newState.internal.routes

    return {
      action: plan.action,
      prevState: plan.prevState,
      newState,
      propagations,
      portOperations: plan.portOperations,
      routesChanged,
    }
  }

  /**
   * Execute port allocate/release operations on the allocator.
   */
  private executePortOps(ops: PortOperation[]): void {
    if (!this.portAllocator) return
    for (const op of ops) {
      if (op.type === 'allocate') {
        const result = this.portAllocator.allocate(op.key)
        if (!result.success) {
          this.logger.error`Port allocation failed for ${op.key}: ${result.error}`
        }
      } else {
        this.portAllocator.release(op.key)
      }
    }
  }

  /**
   * Stamp envoyPort values from the allocator onto routes in the state.
   * Must run after executePortOps() so getPort() returns correct values.
   */
  private stampPortsOnState(state: RouteTable): RouteTable {
    if (!this.portAllocator) return state
    return {
      ...state,
      local: {
        ...state.local,
        routes: state.local.routes.map((r) => {
          const port = this.portAllocator!.getPort(r.name)
          return port && !r.envoyPort ? { ...r, envoyPort: port } : r
        }),
      },
      internal: {
        ...state.internal,
        routes: state.internal.routes.map((r) => {
          const key = `egress_${r.name}_via_${r.peerName}`
          const port = this.portAllocator!.getPort(key)
          return port && !r.envoyPort ? { ...r, envoyPort: port } : r
        }),
      },
    }
  }

  /**
   * Compute which port operations are needed for this state transition.
   * Pure — does not mutate the allocator, only reads existing allocations.
   */
  private computePortOps(
    action: Action,
    newState: RouteTable,
    prevState: RouteTable
  ): PortOperation[] {
    if (!this.portAllocator) return []

    const routeActions = [
      Actions.LocalRouteCreate,
      Actions.LocalRouteDelete,
      Actions.InternalProtocolUpdate,
      Actions.InternalProtocolClose,
      Actions.InternalProtocolOpen,
      Actions.InternalProtocolConnected,
      Actions.Tick,
    ]
    if (!routeActions.includes(action.action)) return []

    const ops: PortOperation[] = []

    // Allocate for local routes without ports
    for (const route of newState.local.routes) {
      if (!route.envoyPort) {
        ops.push({ type: 'allocate', key: route.name })
      }
    }

    // Release deleted local routes
    if (action.action === Actions.LocalRouteDelete) {
      const deletedRoute = prevState.local.routes.find(
        (r) => !newState.local.routes.some((lr) => lr.name === r.name)
      )
      if (deletedRoute) {
        ops.push({ type: 'release', key: deletedRoute.name })
      }
    }

    // Allocate egress ports for internal routes that don't have a local egress port yet.
    // Note: route.envoyPort here is the *remote* peer's port — we check the allocator
    // for whether a *local* egress port has been assigned for this route.
    for (const route of newState.internal.routes) {
      const egressKey = `egress_${route.name}_via_${route.peerName}`
      if (!this.portAllocator.getPort(egressKey)) {
        ops.push({ type: 'allocate', key: egressKey })
      }
    }

    // Release egress ports for closed peer connections
    if (action.action === Actions.InternalProtocolClose) {
      const closedPeer = action.data.peerInfo.name
      const removedRoutes = prevState.internal.routes.filter((r) => r.peerName === closedPeer)
      for (const route of removedRoutes) {
        ops.push({ type: 'release', key: `egress_${route.name}_via_${route.peerName}` })
      }
    }

    // Release egress ports for peers expired by Tick (hold timer expiry)
    if (action.action === Actions.Tick) {
      const removedRoutes = prevState.internal.routes.filter(
        (r) =>
          !newState.internal.routes.some((nr) => nr.name === r.name && nr.peerName === r.peerName)
      )
      for (const route of removedRoutes) {
        ops.push({ type: 'release', key: `egress_${route.name}_via_${route.peerName}` })
      }
    }

    return ops
  }

  private computeNewState(
    action: Action,
    state: RouteTable
  ): { success: true; state: RouteTable } | { success: false; error: string } {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        if (!action.data.peerToken) {
          return { success: false, error: 'peerToken is required when creating a peer' }
        }
        const peerList = state.internal.peers
        if (peerList.find((p) => p.name === action.data.name)) {
          return { success: false, error: 'Peer already exists' }
        }

        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: [
              ...state.internal.peers,
              {
                name: action.data.name,
                endpoint: action.data.endpoint,
                domains: action.data.domains,
                peerToken: action.data.peerToken,
                connectionStatus: 'initializing' as const,
                lastConnected: undefined,
              },
            ],
          },
        }
        break
      }
      case Actions.LocalPeerUpdate: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: peerList.map((p) =>
              p.name === action.data.name
                ? {
                    ...p,
                    endpoint: action.data.endpoint,
                    domains: action.data.domains,
                    peerToken: action.data.peerToken,
                    connectionStatus: 'initializing',
                    lastConnected: undefined,
                  }
                : p
            ),
          },
        }
        break
      }
      case Actions.LocalPeerDelete: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.name)
        if (!peer) {
          return { success: false, error: 'Peer not found' }
        }
        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: peerList.filter((p) => p.name !== action.data.name),
            routes: state.internal.routes.filter((r) => r.peerName !== action.data.name),
          },
        }
        break
      }
      case Actions.InternalProtocolClose: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)

        if (peer) {
          state = {
            ...state,
            internal: {
              ...state.internal,
              routes: state.internal.routes.filter((r) => r.peerName !== action.data.peerInfo.name),
              peers: peerList.filter((p) => p.name !== action.data.peerInfo.name),
            },
          }
        }
        break
      }
      case Actions.InternalProtocolOpen: {
        const peer = state.internal.peers.find((p) => p.name === action.data.peerInfo.name)
        if (!peer) {
          return {
            success: false,
            error: `Peer '${action.data.peerInfo.name}' is not configured on this node`,
          }
        }

        const now = Date.now()
        state = {
          ...state,
          internal: {
            ...state.internal,
            peers: state.internal.peers.map((p) =>
              p.name === action.data.peerInfo.name
                ? { ...p, connectionStatus: 'connected', lastReceived: now }
                : p
            ),
          },
        }
        break
      }
      case Actions.InternalProtocolConnected: {
        const peerList = state.internal.peers
        const peer = peerList.find((p) => p.name === action.data.peerInfo.name)
        if (peer) {
          const now = Date.now()
          state = {
            ...state,
            internal: {
              ...state.internal,
              peers: state.internal.peers.map((p) =>
                p.name === action.data.peerInfo.name
                  ? { ...p, connectionStatus: 'connected', lastReceived: now }
                  : p
              ),
            },
          }
        }
        break
      }
      case Actions.LocalRouteCreate: {
        if (state.local.routes.find((r) => r.name === action.data.name)) {
          return { success: false, error: 'Route already exists' }
        }
        state = {
          ...state,
          local: {
            ...state.local,
            routes: [...state.local.routes, action.data],
          },
        }
        break
      }
      case Actions.LocalRouteDelete: {
        if (!state.local.routes.find((r) => r.name === action.data.name)) {
          return { success: false, error: 'Route not found' }
        }
        state = {
          ...state,
          local: {
            ...state.local,
            routes: state.local.routes.filter((r) => r.name !== action.data.name),
          },
        }
        break
      }
      case Actions.InternalProtocolUpdate: {
        const { peerInfo, update } = action.data
        this.logger
          .info`InternalProtocolUpdate: received ${update.updates.length} updates from ${peerInfo.name}`
        const sourcePeerName = peerInfo.name
        let currentInternalRoutes = [...state.internal.routes]

        for (const u of update.updates) {
          if (u.action === 'add') {
            const nodePath = u.nodePath ?? []

            // Loop Prevention
            if (nodePath.includes(this.config.node.name)) {
              this.logger
                .debug`Drop update from ${peerInfo.name}: loop detected in path [${nodePath.join(', ')}]`
              continue
            }

            // Remove existing if any (upsert)
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => !(r.name === u.route.name && r.peerName === sourcePeerName)
            )
            currentInternalRoutes.push({
              ...u.route,
              peerName: sourcePeerName,
              peer: peerInfo,
              nodePath: nodePath,
            })
          } else if (u.action === 'remove') {
            currentInternalRoutes = currentInternalRoutes.filter(
              (r) => r.name !== u.route.name || r.peerName !== sourcePeerName
            )
          }
        }

        // Update lastReceived for the sending peer
        const now = Date.now()
        state = {
          ...state,
          internal: {
            ...state.internal,
            routes: currentInternalRoutes,
            peers: state.internal.peers.map((p) =>
              p.name === sourcePeerName ? { ...p, lastReceived: now } : p
            ),
          },
        }
        break
      }
      case Actions.Tick: {
        const now = action.data.now
        const expiredPeerNames: string[] = []

        for (const peer of state.internal.peers) {
          if (
            peer.connectionStatus === 'connected' &&
            peer.holdTime != null &&
            peer.lastReceived != null &&
            now - peer.lastReceived > peer.holdTime * 1000
          ) {
            expiredPeerNames.push(peer.name)
            this.logger.info`Hold timer expired for peer ${peer.name}`
          }
        }

        if (expiredPeerNames.length > 0) {
          state = {
            ...state,
            internal: {
              ...state.internal,
              peers: state.internal.peers.filter((p) => !expiredPeerNames.includes(p.name)),
              routes: state.internal.routes.filter((r) => !expiredPeerNames.includes(r.peerName)),
            },
          }
        }
        break
      }
      default: {
        this.logger.warn`Unknown action: ${(action as Action).action}`
        break
      }
    }

    return { success: true, state }
  }

  private buildRouteSyncPayload(
    state: RouteTable,
    targetPeerName: string
  ): { updates: Array<{ action: 'add'; route: DataChannelDefinition; nodePath: string[] }> } {
    return {
      updates: [
        ...state.local.routes.map((r) => ({
          action: 'add' as const,
          route: r,
          nodePath: [this.config.node.name],
        })),
        ...state.internal.routes
          .filter((r) => !r.nodePath.includes(targetPeerName))
          .map((r) => {
            let route = r as DataChannelDefinition
            if (this.config.envoyConfig && this.portAllocator) {
              const egressKey = `egress_${r.name}_via_${r.peerName}`
              const localPort = this.portAllocator.getPort(egressKey)
              if (localPort) {
                route = { ...r, envoyPort: localPort }
              }
            }
            return {
              action: 'add' as const,
              route,
              nodePath: [this.config.node.name, ...r.nodePath],
            }
          }),
      ],
    }
  }

  private computePropagations(
    action: Action,
    newState: RouteTable,
    prevState: RouteTable
  ): Propagation[] {
    switch (action.action) {
      case Actions.LocalPeerCreate: {
        const peerRecord = newState.internal.peers.find((p) => p.name === action.data.name)
        if (peerRecord) {
          return [{ type: 'open', peer: peerRecord, localNode: this.config.node }]
        }
        return []
      }
      case Actions.InternalProtocolOpen: {
        const allRoutes = this.buildRouteSyncPayload(newState, action.data.peerInfo.name)
        if (allRoutes.updates.length === 0) return []

        const localPeer = newState.internal.peers.find((p) => p.name === action.data.peerInfo.name)
        if (!localPeer?.peerToken) {
          this.logger
            .error`CRITICAL: no peerToken for ${action.data.peerInfo.name} — cannot sync routes`
          return []
        }
        return [{ type: 'update', peer: localPeer, localNode: this.config.node, update: allRoutes }]
      }
      case Actions.InternalProtocolConnected: {
        const allRoutes = this.buildRouteSyncPayload(newState, action.data.peerInfo.name)
        if (allRoutes.updates.length === 0) return []

        if (!action.data.peerInfo.peerToken) {
          this.logger
            .error`CRITICAL: no peerToken for ${action.data.peerInfo.name} — cannot sync routes`
          return []
        }
        const peerRecord: PeerRecord = {
          ...action.data.peerInfo,
          peerToken: action.data.peerInfo.peerToken,
          connectionStatus: 'connected',
        }
        return [
          { type: 'update', peer: peerRecord, localNode: this.config.node, update: allRoutes },
        ]
      }
      case Actions.LocalPeerDelete: {
        const propagations: Propagation[] = []

        const deletedPeer = prevState.internal.peers.find((p) => p.name === action.data.name)
        if (deletedPeer) {
          propagations.push({
            type: 'close',
            peer: deletedPeer,
            localNode: this.config.node,
            code: 1000,
            reason: 'Peer removed',
          })
        }

        propagations.push(
          ...this.computeWithdrawalPropagations(action.data.name, prevState, newState)
        )
        return propagations
      }
      case Actions.LocalRouteCreate: {
        const connectedPeers = newState.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        const update = {
          updates: [
            { action: 'add' as const, route: action.data, nodePath: [this.config.node.name] },
          ],
        }
        return connectedPeers.map((peer) => ({
          type: 'update' as const,
          peer,
          localNode: this.config.node,
          update,
        }))
      }
      case Actions.LocalRouteDelete: {
        const connectedPeersDelete = newState.internal.peers.filter(
          (p) => p.connectionStatus === 'connected'
        )
        const deleteUpdate = {
          updates: [{ action: 'remove' as const, route: action.data }],
        }
        return connectedPeersDelete.map((peer) => ({
          type: 'update' as const,
          peer,
          localNode: this.config.node,
          update: deleteUpdate,
        }))
      }
      case Actions.InternalProtocolUpdate: {
        const sourcePeerName = action.data.peerInfo.name
        const propagations: Propagation[] = []

        for (const peer of newState.internal.peers.filter(
          (p) => p.connectionStatus === 'connected' && p.name !== sourcePeerName
        )) {
          const safeUpdates = action.data.update.updates.filter((u) => {
            if (u.action === 'remove') return true
            const path = u.nodePath ?? []
            if (path.includes(this.config.node.name)) return false
            if (path.includes(peer.name)) return false
            return true
          })

          if (safeUpdates.length === 0) continue

          const updatesWithPrepend = {
            updates: safeUpdates.map((u) => {
              if (u.action === 'add') {
                const rewritten = {
                  ...u,
                  nodePath: [this.config.node.name, ...(u.nodePath ?? [])],
                }
                if (this.config.envoyConfig && this.portAllocator) {
                  const egressKey = `egress_${u.route.name}_via_${sourcePeerName}`
                  const localPort = this.portAllocator.getPort(egressKey)
                  if (localPort) {
                    rewritten.route = { ...u.route, envoyPort: localPort }
                  }
                }
                return rewritten
              }
              return u
            }),
          }

          propagations.push({
            type: 'update',
            peer,
            localNode: this.config.node,
            update: updatesWithPrepend,
          })
        }

        return propagations
      }
      case Actions.InternalProtocolClose: {
        return this.computeWithdrawalPropagations(action.data.peerInfo.name, prevState, newState)
      }
      case Actions.Tick: {
        const now = action.data.now
        const propagations: Propagation[] = []

        // 1. Withdrawals for expired peers (processed first)
        const expiredPeerNames = prevState.internal.peers
          .filter(
            (p) =>
              p.connectionStatus === 'connected' &&
              p.holdTime != null &&
              p.lastReceived != null &&
              now - p.lastReceived > p.holdTime * 1000
          )
          .map((p) => p.name)

        for (const expiredName of expiredPeerNames) {
          propagations.push(...this.computeWithdrawalPropagations(expiredName, prevState, newState))
        }

        // 2. Keepalives for healthy peers (after expirations)
        for (const peer of newState.internal.peers) {
          if (
            peer.connectionStatus === 'connected' &&
            peer.holdTime != null &&
            peer.lastSent != null &&
            now - peer.lastSent > (peer.holdTime / 3) * 1000
          ) {
            propagations.push({ type: 'keepalive', peer })
          }
        }

        return propagations
      }
      default:
        return []
    }
  }

  private computeWithdrawalPropagations(
    peerName: string,
    prevState: RouteTable,
    newState: RouteTable
  ): Propagation[] {
    const removedRoutes = prevState.internal.routes.filter((r) => r.peerName === peerName)
    if (removedRoutes.length === 0) return []

    this.logger.info`Propagating withdrawal of ${removedRoutes.length} routes from ${peerName}`

    const withdrawalUpdate = {
      updates: removedRoutes.map((r) => ({ action: 'remove' as const, route: r })),
    }

    return newState.internal.peers
      .filter((p) => p.connectionStatus === 'connected' && p.name !== peerName)
      .map((peer) => ({
        type: 'update' as const,
        peer,
        localNode: this.config.node,
        update: withdrawalUpdate,
      }))
  }

  private computeRouteMetadata(state: RouteTable): Map<string, LocRibEntry> {
    const metadata = new Map<string, LocRibEntry>()

    // Group internal routes by name (prefix)
    const routesByName = new Map<string, InternalRoute[]>()
    for (const route of state.internal.routes) {
      const existing = routesByName.get(route.name)
      if (existing) {
        existing.push(route)
      } else {
        routesByName.set(route.name, [route])
      }
    }

    for (const [name, routes] of routesByName) {
      if (routes.length === 1) {
        metadata.set(name, {
          bestPath: routes[0],
          alternatives: [],
          selectionReason: 'only candidate',
        })
      } else {
        // Select best: shortest nodePath wins
        const sorted = [...routes].sort((a, b) => a.nodePath.length - b.nodePath.length)
        const best = sorted[0]
        const alternatives = sorted.slice(1)
        metadata.set(name, {
          bestPath: best,
          alternatives,
          selectionReason: 'shortest nodePath',
        })
      }
    }

    return metadata
  }
}
