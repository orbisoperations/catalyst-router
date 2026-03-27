import { Actions } from '../action-types.js'
import { CloseCodes } from '../close-codes.js'
import { routeKey } from '../datachannel.js'
import {
  mapWith,
  mapWithout,
  nestedMapGet,
  nestedMapSet,
  nestedMapDelete,
  nestedMapDeleteOuter,
} from '../map-helpers.js'
import type { Action } from '../schema.js'
import type { ActionLog } from '../journal/action-log.js'
import {
  newRouteTable,
  internalRouteKey,
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
type LocalRouteHealthUpdateData = Extract<
  Action,
  { action: typeof Actions.LocalRouteHealthUpdate }
>['data']
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
      case Actions.LocalRouteHealthUpdate:
        return this.planLocalRouteHealthUpdate(action.data, state)
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
    if (state.internal.peers.has(data.name)) return noChange(state)
    const newPeer: PeerRecord = {
      ...data,
      connectionStatus: 'initializing',
      lastConnected: 0,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 0,
    }
    const newState: RouteTable = {
      ...state,
      internal: {
        ...state.internal,
        peers: mapWith(state.internal.peers, data.name, newPeer),
      },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planLocalPeerUpdate(data: PeerInfo, state: RouteTable): PlanResult {
    const existing = state.internal.peers.get(data.name)
    if (existing === undefined) return noChange(state)
    const updated: PeerRecord = {
      ...existing,
      ...data,
      connectionStatus: existing.connectionStatus,
      lastConnected: existing.lastConnected,
      holdTime: existing.holdTime,
      lastSent: existing.lastSent,
      lastReceived: existing.lastReceived,
    }
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers: mapWith(state.internal.peers, data.name, updated) },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planLocalPeerDelete(data: LocalPeerDeleteData, state: RouteTable): PlanResult {
    if (!state.internal.peers.has(data.name)) return noChange(state)
    const peerRouteMap = state.internal.routes.get(data.name)
    const removedRoutes = peerRouteMap ? [...peerRouteMap.values()] : []
    const portOps: PortOperation[] = removedRoutes
      .filter((r) => r.envoyPort != null)
      .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))
    const routeChanges: RouteChange[] = removedRoutes.map((r) => ({
      type: 'removed' as const,
      route: r,
    }))
    const newState: RouteTable = {
      ...state,
      internal: {
        peers: mapWithout(state.internal.peers, data.name),
        routes: nestedMapDeleteOuter(state.internal.routes, data.name),
      },
    }
    return { prevState: state, newState, portOps, routeChanges }
  }

  // -------------------------------------------------------------------------
  // Local route handlers
  // -------------------------------------------------------------------------

  private planLocalRouteCreate(data: LocalRouteCreateData, state: RouteTable): PlanResult {
    if (state.local.routes.has(routeKey(data))) return noChange(state)
    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes: mapWith(state.local.routes, routeKey(data), data) },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: [{ type: 'added', route: data }],
    }
  }

  private planLocalRouteDelete(data: LocalRouteDeleteData, state: RouteTable): PlanResult {
    const route = state.local.routes.get(routeKey(data))
    if (route === undefined) return noChange(state)
    const portOps: PortOperation[] =
      route.envoyPort != null
        ? [{ type: 'release' as const, routeKey: routeKey(route), port: route.envoyPort }]
        : NO_PORT_OPS
    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes: mapWithout(state.local.routes, routeKey(data)) },
    }
    return {
      prevState: state,
      newState,
      portOps,
      routeChanges: [{ type: 'removed', route }],
    }
  }

  private planLocalRouteHealthUpdate(
    data: LocalRouteHealthUpdateData,
    state: RouteTable
  ): PlanResult {
    const existing = state.local.routes.get(data.name)
    if (existing === undefined) return noChange(state)

    // No-op if health fields are identical (prevent iBGP churn)
    if (
      existing.healthStatus === data.healthStatus &&
      existing.responseTimeMs === data.responseTimeMs &&
      existing.lastCheckedAt === data.lastCheckedAt
    ) {
      return noChange(state)
    }

    const updated = {
      ...existing,
      healthStatus: data.healthStatus,
      responseTimeMs: data.responseTimeMs,
      lastCheckedAt: data.lastCheckedAt,
    }
    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes: mapWith(state.local.routes, data.name, updated) },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: [{ type: 'updated', route: updated }],
    }
  }

  // -------------------------------------------------------------------------
  // Internal protocol handlers
  // -------------------------------------------------------------------------

  private planInternalProtocolOpen(data: InternalProtocolOpenData, state: RouteTable): PlanResult {
    const existing = state.internal.peers.get(data.peerInfo.name)
    if (existing === undefined) return noChange(state)
    const negotiatedHoldTime =
      data.holdTime != null ? Math.min(existing.holdTime, data.holdTime) : existing.holdTime
    const updated: PeerRecord = {
      ...existing,
      connectionStatus: 'connected',
      holdTime: negotiatedHoldTime,
      lastReceived: Date.now(),
    }
    const newState: RouteTable = {
      ...state,
      internal: {
        ...state.internal,
        peers: mapWith(state.internal.peers, data.peerInfo.name, updated),
      },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planInternalProtocolConnected(
    data: InternalProtocolConnectedData,
    state: RouteTable
  ): PlanResult {
    const existing = state.internal.peers.get(data.peerInfo.name)
    if (existing === undefined) return noChange(state)
    // Reset holdTime to default on reconnect so it can be re-negotiated
    // via the subsequent InternalProtocolOpen exchange.
    const now = Date.now()
    const updated: PeerRecord = {
      ...existing,
      connectionStatus: 'connected',
      lastConnected: now,
      lastReceived: now,
      holdTime: 90_000,
      lastSent: 0,
    }
    const newState: RouteTable = {
      ...state,
      internal: {
        ...state.internal,
        peers: mapWith(state.internal.peers, data.peerInfo.name, updated),
      },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  private planInternalProtocolClose(
    data: InternalProtocolCloseData,
    state: RouteTable
  ): PlanResult {
    const existing = state.internal.peers.get(data.peerInfo.name)
    if (existing === undefined) return noChange(state)

    const isTransportError = data.code === CloseCodes.TRANSPORT_ERROR
    const peerRouteMap = state.internal.routes.get(data.peerInfo.name)
    const peerRoutes = peerRouteMap ? [...peerRouteMap.values()] : []

    let routes: RouteTable['internal']['routes']
    let routeChanges: RouteChange[]
    let portOps: PortOperation[]

    if (isTransportError) {
      if (peerRouteMap && peerRouteMap.size > 0) {
        const staleInner = new Map<string, InternalRoute>()
        for (const [key, r] of peerRouteMap) {
          staleInner.set(key, { ...r, isStale: true })
        }
        routes = mapWith(state.internal.routes, data.peerInfo.name, staleInner)
      } else {
        routes = state.internal.routes
      }
      routeChanges = peerRoutes.map((r) => ({
        type: 'updated' as const,
        route: { ...r, isStale: true },
      }))
      portOps = NO_PORT_OPS
    } else {
      routes = nestedMapDeleteOuter(state.internal.routes, data.peerInfo.name)
      routeChanges = peerRoutes.map((r) => ({ type: 'removed' as const, route: r }))
      portOps = peerRoutes
        .filter((r) => r.envoyPort != null)
        .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))
    }

    const peers = mapWith(state.internal.peers, data.peerInfo.name, {
      ...existing,
      connectionStatus: 'closed' as const,
    })
    const newState: RouteTable = { ...state, internal: { peers, routes } }
    return { prevState: state, newState, portOps, routeChanges }
  }

  private planInternalProtocolUpdate(
    data: InternalProtocolUpdateData,
    state: RouteTable
  ): PlanResult {
    let routes = state.internal.routes
    const portOps: PortOperation[] = []
    const routeChanges: RouteChange[] = []

    for (const item of data.update.updates) {
      if (item.action === 'add') {
        if (item.nodePath.includes(this._nodeId)) continue

        const irKey = internalRouteKey({ name: item.route.name, originNode: item.originNode })
        const existing = nestedMapGet(routes, data.peerInfo.name, irKey)

        const newRoute: InternalRoute = {
          ...item.route,
          peer: data.peerInfo,
          nodePath: item.nodePath,
          originNode: item.originNode,
          isStale: false,
        }

        if (existing !== undefined) {
          const betterPath = item.nodePath.length < existing.nodePath.length
          const replacingStale = existing.isStale === true
          if (betterPath || replacingStale) {
            routes = nestedMapSet(routes, data.peerInfo.name, irKey, newRoute)
            routeChanges.push({ type: 'updated', route: newRoute })
          }
        } else {
          routes = nestedMapSet(routes, data.peerInfo.name, irKey, newRoute)
          routeChanges.push({ type: 'added', route: newRoute })
        }
      } else {
        // action === 'remove'
        const irKey = internalRouteKey({ name: item.route.name, originNode: item.originNode })
        const removed = nestedMapGet(routes, data.peerInfo.name, irKey)
        if (removed !== undefined) {
          routes = nestedMapDelete(routes, data.peerInfo.name, irKey)
          routeChanges.push({ type: 'removed', route: removed })
          if (removed.envoyPort != null) {
            portOps.push({ type: 'release', routeKey: routeKey(removed), port: removed.envoyPort })
          }
        }
      }
    }

    // Always update lastReceived on the peer, even when no routes changed
    const existingPeer = state.internal.peers.get(data.peerInfo.name)
    const peers =
      existingPeer !== undefined
        ? mapWith(state.internal.peers, data.peerInfo.name, {
            ...existingPeer,
            lastReceived: Date.now(),
          })
        : state.internal.peers

    if (routeChanges.length === 0 && existingPeer === undefined) {
      return noChange(state)
    }

    const newState: RouteTable = { ...state, internal: { peers, routes } }
    return { prevState: state, newState, portOps, routeChanges }
  }

  private planInternalProtocolKeepalive(
    data: InternalProtocolKeepaliveData,
    state: RouteTable
  ): PlanResult {
    const existing = state.internal.peers.get(data.peerInfo.name)
    if (existing === undefined) return noChange(state)
    const peers = mapWith(state.internal.peers, data.peerInfo.name, {
      ...existing,
      lastReceived: Date.now(),
    })
    const newState: RouteTable = { ...state, internal: { ...state.internal, peers } }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges: NO_ROUTE_CHANGES }
  }

  // -------------------------------------------------------------------------
  // System handlers
  // -------------------------------------------------------------------------

  private planTick(data: TickData, state: RouteTable): PlanResult {
    const expiredPeerNames = new Set<string>()
    let peers = state.internal.peers

    for (const [name, p] of state.internal.peers) {
      const timerActive = p.connectionStatus === 'connected' && p.holdTime > 0 && p.lastReceived > 0
      if (timerActive && data.now - p.lastReceived > p.holdTime) {
        expiredPeerNames.add(name)
        peers = mapWith(peers, name, { ...p, connectionStatus: 'closed' as const })
      }
    }

    const stalePeerNames = new Set<string>()
    for (const [name, p] of peers) {
      if (
        p.connectionStatus === 'closed' &&
        p.holdTime > 0 &&
        p.lastReceived > 0 &&
        data.now - p.lastReceived > p.holdTime
      ) {
        const peerRouteMap = state.internal.routes.get(name)
        if (peerRouteMap) {
          const hasStaleRoutes = [...peerRouteMap.values()].some((r) => r.isStale === true)
          if (hasStaleRoutes) stalePeerNames.add(name)
        }
      }
    }

    const purgedPeerNames = new Set([...expiredPeerNames, ...stalePeerNames])
    if (purgedPeerNames.size === 0) return noChange(state)

    const removedRoutes: InternalRoute[] = []
    let routes = state.internal.routes
    for (const peerName of purgedPeerNames) {
      const peerRouteMap = routes.get(peerName)
      if (peerRouteMap) {
        removedRoutes.push(...peerRouteMap.values())
        routes = nestedMapDeleteOuter(routes, peerName)
      }
    }

    const portOps: PortOperation[] = removedRoutes
      .filter((r) => r.envoyPort != null)
      .map((r) => ({ type: 'release' as const, routeKey: routeKey(r), port: r.envoyPort! }))
    const routeChanges: RouteChange[] = removedRoutes.map((r) => ({
      type: 'removed' as const,
      route: r,
    }))

    const newState: RouteTable = { ...state, internal: { peers, routes } }
    return { prevState: state, newState, portOps, routeChanges }
  }
}
