import { Actions } from '../action-types.js'
import { CloseCodes } from '../close-codes.js'
import { routeKey } from '../datachannel.js'
import type { Action } from '../schema.js'
import type { ActionLog } from '../journal/action-log.js'
import {
  newRouteTable,
  type RouteTable,
  type PeerRecord,
  type InternalRoute,
  type PeerInfo,
} from '../state.js'
import type { PlanResult, PortOperation, RouteChange } from '../port-operation.js'

// ---------------------------------------------------------------------------
// Derived action data types — extracted from schema discriminated union members
// ---------------------------------------------------------------------------

type LocalPeerDeleteData = Extract<Action, { action: typeof Actions.LocalPeerDelete }>['data']
type LocalRouteCreateData = Extract<Action, { action: typeof Actions.LocalRouteCreate }>['data']
type LocalRouteDeleteData = Extract<Action, { action: typeof Actions.LocalRouteDelete }>['data']
type InternalProtocolOpenData = Extract<
  Action,
  { action: typeof Actions.InternalProtocolOpen }
>['data']
type InternalProtocolConnectedData = Extract<
  Action,
  { action: typeof Actions.InternalProtocolConnected }
>['data']
type InternalProtocolCloseData = Extract<
  Action,
  { action: typeof Actions.InternalProtocolClose }
>['data']
type InternalProtocolUpdateData = Extract<
  Action,
  { action: typeof Actions.InternalProtocolUpdate }
>['data']
type InternalProtocolKeepaliveData = Extract<
  Action,
  { action: typeof Actions.InternalProtocolKeepalive }
>['data']
type TickData = Extract<Action, { action: typeof Actions.Tick }>['data']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ROUTE_CHANGES: RouteChange[] = []
const NO_PORT_OPS: PortOperation[] = []

function noChange(state: RouteTable): PlanResult {
  return { prevState: state, newState: state, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
}

// ---------------------------------------------------------------------------
// RoutingInformationBase
// ---------------------------------------------------------------------------

/**
 * Core routing state machine. Processes Actions through a pure plan/commit
 * pipeline:
 *
 *   const plan = rib.plan(action, rib.state)   // pure, no side effects
 *   const newState = rib.commit(plan, action)   // applies state + journals
 *
 * All handler methods are pure functions — they never mutate their inputs and
 * always return a new RouteTable by value (or the same reference on no-op).
 * Callers can detect a real state change via `plan.prevState !== plan.newState`.
 */
export class RoutingInformationBase {
  private _state: RouteTable
  private readonly _nodeId: string
  private readonly _journal: ActionLog | undefined

  constructor(opts: { nodeId: string; journal?: ActionLog; initialState?: RouteTable }) {
    this._nodeId = opts.nodeId
    this._journal = opts.journal
    this._state = opts.initialState ?? newRouteTable()
  }

  get state(): RouteTable {
    return this._state
  }

  get nodeId(): string {
    return this._nodeId
  }

  /**
   * Pure, synchronous state transition.
   *
   * Returns a PlanResult describing what would change. The input `state` is
   * never mutated. If the action is a no-op (peer not found, duplicate, etc.)
   * `prevState === newState` (same object reference).
   */
  plan(action: Action, state: RouteTable): PlanResult {
    switch (action.action) {
      case Actions.LocalPeerCreate:
        return this.planLocalPeerCreate(action.data, state)
      case Actions.LocalPeerUpdate:
        return this.planLocalPeerUpdate(action.data, state)
      case Actions.LocalPeerDelete:
        return this.planLocalPeerDelete(action.data, state)
      case Actions.LocalRouteCreate:
        return this.planLocalRouteCreate(action.data, state)
      case Actions.LocalRouteDelete:
        return this.planLocalRouteDelete(action.data, state)
      case Actions.InternalProtocolOpen:
        return this.planInternalProtocolOpen(action.data, state)
      case Actions.InternalProtocolConnected:
        return this.planInternalProtocolConnected(action.data, state)
      case Actions.InternalProtocolClose:
        return this.planInternalProtocolClose(action.data, state)
      case Actions.InternalProtocolUpdate:
        return this.planInternalProtocolUpdate(action.data, state)
      case Actions.InternalProtocolKeepalive:
        return this.planInternalProtocolKeepalive(action.data, state)
      case Actions.Tick:
        return this.planTick(action.data, state)
      default:
        return noChange(state)
    }
  }

  /**
   * Apply a committed plan: replace internal state and record to journal
   * (only when the state actually changed).
   *
   * The action is passed separately so the journal can store the full action
   * independently of the plan.
   */
  commit(plan: PlanResult, action: Action): RouteTable {
    this._state = plan.newState
    if (this.stateChanged(plan) && this._journal !== undefined) {
      this._journal.append(action, this._nodeId)
    }
    return this._state
  }

  /**
   * Returns true when the plan produced a real state change.
   * Uses reference equality — handlers guarantee same-reference on no-op.
   */
  stateChanged(plan: PlanResult): boolean {
    return plan.prevState !== plan.newState
  }

  // -------------------------------------------------------------------------
  // Local peer handlers
  // -------------------------------------------------------------------------

  private planLocalPeerCreate(data: PeerInfo, state: RouteTable): PlanResult {
    const exists = state.internal.peers.some((p) => p.name === data.name)
    if (exists) return noChange(state)

    const newPeer: PeerRecord = {
      ...data,
      connectionStatus: 'initializing',
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }
    const newState: RouteTable = {
      ...state,
      internal: {
        ...state.internal,
        peers: [...state.internal.peers, newPeer],
      },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planLocalPeerUpdate(data: PeerInfo, state: RouteTable): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.name)
    if (idx === -1) return noChange(state)

    const existing = state.internal.peers[idx]
    const updated: PeerRecord = {
      // Apply all incoming PeerInfo fields
      ...existing,
      ...data,
      // Preserve runtime-only fields — they are managed by protocol events
      connectionStatus: existing.connectionStatus,
      lastConnected: existing.lastConnected,
      holdTime: existing.holdTime,
      lastSent: existing.lastSent,
      lastReceived: existing.lastReceived,
    }
    const peers = state.internal.peers.map((p, i) => (i === idx ? updated : p))
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planLocalPeerDelete(data: LocalPeerDeleteData, state: RouteTable): PlanResult {
    const peers = state.internal.peers.filter((p) => p.name !== data.name)
    if (peers.length === state.internal.peers.length) return noChange(state)

    const removedRoutes = state.internal.routes.filter((r) => r.peer.name === data.name)
    const routes = state.internal.routes.filter((r) => r.peer.name !== data.name)

    const portOps: PortOperation[] = removedRoutes
      .filter((r) => r.envoyPort != null)
      .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))

    const routeChanges: RouteChange[] = removedRoutes.map((r) => ({
      type: 'removed' as const,
      route: r,
    }))

    const newState: RouteTable = {
      ...state,
      internal: { peers, routes },
    }
    return { prevState: state, newState, portOps, routeChanges }
  }

  // -------------------------------------------------------------------------
  // Local route handlers
  // -------------------------------------------------------------------------

  private planLocalRouteCreate(data: LocalRouteCreateData, state: RouteTable): PlanResult {
    const exists = state.local.routes.some((r) => r.name === data.name)
    if (exists) return noChange(state)

    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes: [...state.local.routes, data] },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: [{ type: 'added', route: data }],
    }
  }

  private planLocalRouteDelete(data: LocalRouteDeleteData, state: RouteTable): PlanResult {
    const route = state.local.routes.find((r) => r.name === data.name)
    if (route === undefined) return noChange(state)

    const routes = state.local.routes.filter((r) => r.name !== data.name)
    const portOps: PortOperation[] =
      route.envoyPort != null
        ? [{ type: 'release' as const, routeKey: routeKey(route), port: route.envoyPort }]
        : NO_PORT_OPS

    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes },
    }
    return {
      prevState: state,
      newState,
      portOps,
      routeChanges: [{ type: 'removed', route }],
    }
  }

  // -------------------------------------------------------------------------
  // Internal protocol handlers
  // -------------------------------------------------------------------------

  private planInternalProtocolOpen(data: InternalProtocolOpenData, state: RouteTable): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    // Unknown peer — we only accept opens for pre-configured peers
    if (idx === -1) return noChange(state)

    const existing = state.internal.peers[idx]
    const negotiatedHoldTime =
      data.holdTime != null ? Math.min(existing.holdTime, data.holdTime) : existing.holdTime

    const updated: PeerRecord = {
      ...existing,
      connectionStatus: 'connected',
      holdTime: negotiatedHoldTime,
      lastReceived: Date.now(),
    }
    const peers = state.internal.peers.map((p, i) => (i === idx ? updated : p))
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planInternalProtocolConnected(
    data: InternalProtocolConnectedData,
    state: RouteTable
  ): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    if (idx === -1) return noChange(state)

    const existing = state.internal.peers[idx]
    const updated: PeerRecord = {
      ...existing,
      connectionStatus: 'connected',
      lastConnected: new Date(),
      lastReceived: Date.now(),
    }
    const peers = state.internal.peers.map((p, i) => (i === idx ? updated : p))
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planInternalProtocolClose(
    data: InternalProtocolCloseData,
    state: RouteTable
  ): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    if (idx === -1) return noChange(state)

    const isTransportError = data.code === CloseCodes.TRANSPORT_ERROR
    const peerRoutes = state.internal.routes.filter((r) => r.peer.name === data.peerInfo.name)

    let routes: InternalRoute[]
    let routeChanges: RouteChange[]
    let portOps: PortOperation[]

    if (isTransportError) {
      // Graceful-restart behaviour: mark routes stale rather than withdrawing
      // them immediately. They will be replaced on reconnect or purged by Tick
      // once the peer's holdTime grace period elapses without reconnection.
      routes = state.internal.routes.map((r) =>
        r.peer.name === data.peerInfo.name ? { ...r, isStale: true } : r
      )
      routeChanges = peerRoutes.map((r) => ({
        type: 'updated' as const,
        route: { ...r, isStale: true },
      }))
      portOps = NO_PORT_OPS
    } else {
      // Hard close (normal, hold-expired, admin-shutdown, protocol-error):
      // withdraw routes and release any allocated envoy ports.
      routes = state.internal.routes.filter((r) => r.peer.name !== data.peerInfo.name)
      routeChanges = peerRoutes.map((r) => ({ type: 'removed' as const, route: r }))
      portOps = peerRoutes
        .filter((r) => r.envoyPort != null)
        .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))
    }

    const peers = state.internal.peers.map((p, i) =>
      i === idx ? { ...p, connectionStatus: 'closed' as const } : p
    )
    const newState: RouteTable = {
      ...state,
      internal: { peers, routes },
    }
    return { prevState: state, newState, portOps, routeChanges }
  }

  private planInternalProtocolUpdate(
    data: InternalProtocolUpdateData,
    state: RouteTable
  ): PlanResult {
    let routes = [...state.internal.routes]
    const portOps: PortOperation[] = []
    const routeChanges: RouteChange[] = []

    for (const item of data.update.updates) {
      if (item.action === 'add') {
        // Loop detection — discard advertisements that already include this node
        if (item.nodePath.includes(this._nodeId)) continue

        const key = routeKey(item.route)
        const existingIdx = routes.findIndex(
          (r) => routeKey(r) === key && r.originNode === item.originNode
        )

        const newRoute: InternalRoute = {
          ...item.route,
          peer: data.peerInfo,
          nodePath: item.nodePath,
          originNode: item.originNode,
          isStale: false,
        }

        if (existingIdx !== -1) {
          const existing = routes[existingIdx]
          // Best-path selection: prefer shorter path, or replace a stale route
          const betterPath = item.nodePath.length < existing.nodePath.length
          const replacingStale = existing.isStale === true
          if (betterPath || replacingStale) {
            routes = routes.map((r, i) => (i === existingIdx ? newRoute : r))
            routeChanges.push({ type: 'updated', route: newRoute })
          }
          // else: existing path is equal or better and fresh — no change
        } else {
          routes = [...routes, newRoute]
          routeChanges.push({ type: 'added', route: newRoute })
        }
      } else {
        // action === 'remove'
        const key = routeKey(item.route)
        const removed = routes.find((r) => routeKey(r) === key && r.originNode === item.originNode)
        if (removed !== undefined) {
          routes = routes.filter((r) => !(routeKey(r) === key && r.originNode === item.originNode))
          routeChanges.push({ type: 'removed', route: removed })
          if (removed.envoyPort != null) {
            portOps.push({ type: 'release', routeKey: key, port: removed.envoyPort })
          }
        }
      }
    }

    // Always update lastReceived on the peer, even when no routes changed
    const peerIdx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    const peers =
      peerIdx !== -1
        ? state.internal.peers.map((p, i) =>
            i === peerIdx ? { ...p, lastReceived: Date.now() } : p
          )
        : state.internal.peers

    // No-op: no route changes and peer was unknown (nothing touched)
    if (routeChanges.length === 0 && peerIdx === -1) {
      return noChange(state)
    }

    const newState: RouteTable = {
      ...state,
      internal: { peers, routes },
    }
    return { prevState: state, newState, portOps, routeChanges }
  }

  private planInternalProtocolKeepalive(
    data: InternalProtocolKeepaliveData,
    state: RouteTable
  ): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    if (idx === -1) return noChange(state)

    const peers = state.internal.peers.map((p, i) =>
      i === idx ? { ...p, lastReceived: Date.now() } : p
    )
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  // -------------------------------------------------------------------------
  // System handlers
  // -------------------------------------------------------------------------

  private planTick(data: TickData, state: RouteTable): PlanResult {
    // Find connected peers whose hold timer has expired
    const expiredPeerNames = new Set<string>()
    const peers = state.internal.peers.map((p) => {
      const timerActive = p.connectionStatus === 'connected' && p.holdTime > 0 && p.lastReceived > 0
      if (timerActive && data.now - p.lastReceived > p.holdTime) {
        expiredPeerNames.add(p.name)
        return { ...p, connectionStatus: 'closed' as const }
      }
      return p
    })

    // Find closed peers whose stale routes have exceeded the hold timer grace
    // period. After a transport-error close, routes are marked stale to allow
    // reconnect. Once holdTime elapses without reconnect, purge them.
    const stalePeerNames = new Set<string>()
    for (const p of peers) {
      if (
        p.connectionStatus === 'closed' &&
        p.holdTime > 0 &&
        p.lastReceived > 0 &&
        data.now - p.lastReceived > p.holdTime
      ) {
        const hasStaleRoutes = state.internal.routes.some(
          (r) => r.peer.name === p.name && r.isStale === true
        )
        if (hasStaleRoutes) stalePeerNames.add(p.name)
      }
    }

    const purgedPeerNames = new Set([...expiredPeerNames, ...stalePeerNames])
    if (purgedPeerNames.size === 0) return noChange(state)

    const removedRoutes = state.internal.routes.filter((r) => purgedPeerNames.has(r.peer.name))
    const routes = state.internal.routes.filter((r) => !purgedPeerNames.has(r.peer.name))

    const portOps: PortOperation[] = removedRoutes
      .filter((r) => r.envoyPort != null)
      .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))

    const routeChanges: RouteChange[] = removedRoutes.map((r) => ({
      type: 'removed' as const,
      route: r,
    }))

    const newState: RouteTable = {
      ...state,
      internal: { peers, routes },
    }
    return { prevState: state, newState, portOps, routeChanges }
  }
}
