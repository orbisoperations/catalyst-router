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
import type { FlapStateChange, PlanResult, PortOperation, RouteChange } from '../port-operation.js'

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
type AdminGracefulShutdownData = Extract<
  Action,
  { action: typeof Actions.AdminGracefulShutdown }
>['data']
type AdminCancelShutdownData = Extract<
  Action,
  { action: typeof Actions.AdminCancelShutdown }
>['data']

// ---------------------------------------------------------------------------
// Flap damping constants (RFC 2439 / RFC 7196 / RIPE-580)
// ---------------------------------------------------------------------------
export const FLAP_PENALTY_INCREMENT = 1000
export const FLAP_SUPPRESS_THRESHOLD = 6000
export const FLAP_REUSE_THRESHOLD = 750
export const FLAP_HALF_LIFE_MS = 300_000 // 5 minutes
export const FLAP_MAX_SUPPRESS_MS = 1_800_000 // 30 minutes

export type FlapEntry = {
  penalty: number
  suppressed: boolean
  suppressedAt: number | null
  lastUpdated: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ROUTE_CHANGES: RouteChange[] = []
const NO_PORT_OPS: PortOperation[] = []
const NO_FLAP_CHANGES: FlapStateChange[] = []

/** Canonical key for flap-damping state entries: `routeKey:originNode`. */
export function flapKey(rKey: string, originNode: string): string {
  return `${rKey}:${originNode}`
}

function noChange(state: RouteTable): PlanResult {
  return {
    prevState: state,
    newState: state,
    portOps: NO_PORT_OPS,
    routeChanges: NO_ROUTE_CHANGES,
    flapStateChanges: NO_FLAP_CHANGES,
  }
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

  /** Ephemeral flap damping state — does not survive restart. */
  private _flapState = new Map<string, FlapEntry>()

  get flapState(): ReadonlyMap<string, FlapEntry> {
    return this._flapState
  }

  private decayPenalty(entry: FlapEntry, now: number): number {
    const elapsed = now - entry.lastUpdated
    if (elapsed <= 0) return entry.penalty
    return entry.penalty * Math.pow(0.5, elapsed / FLAP_HALF_LIFE_MS)
  }

  /**
   * Pure, synchronous state transition.
   *
   * Returns a PlanResult describing what would change. The input `state` is
   * never mutated. If the action is a no-op (peer not found, duplicate, etc.)
   * `prevState === newState` (same object reference).
   */
  plan(action: Action, state: RouteTable, now?: number): PlanResult {
    const timestamp = now ?? Date.now()
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
        return this.planInternalProtocolOpen(action.data, state, timestamp)
      case Actions.InternalProtocolConnected:
        return this.planInternalProtocolConnected(action.data, state, timestamp)
      case Actions.InternalProtocolClose:
        return this.planInternalProtocolClose(action.data, state)
      case Actions.InternalProtocolUpdate:
        return this.planInternalProtocolUpdate(action.data, state, timestamp)
      case Actions.InternalProtocolKeepalive:
        return this.planInternalProtocolKeepalive(action.data, state, timestamp)
      case Actions.Tick:
        return this.planTick(action.data, state)
      case Actions.AdminGracefulShutdown:
        return this.planAdminGracefulShutdown(action.data, state)
      case Actions.AdminCancelShutdown:
        return this.planAdminCancelShutdown(action.data, state)
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
    // Apply deferred flap state mutations (collected during plan, applied here)
    for (const change of plan.flapStateChanges) {
      if (change.entry === null) {
        this._flapState.delete(change.key)
      } else {
        this._flapState.set(change.key, change.entry)
      }
    }
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

  private planLocalPeerCreate(
    data: PeerInfo & { maxPrefixes?: number },
    state: RouteTable
  ): PlanResult {
    const exists = state.internal.peers.some((p) => p.name === data.name)
    if (exists) return noChange(state)

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
        peers: [...state.internal.peers, newPeer],
      },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: NO_ROUTE_CHANGES,
      flapStateChanges: NO_FLAP_CHANGES,
    }
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
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: NO_ROUTE_CHANGES,
      flapStateChanges: NO_FLAP_CHANGES,
    }
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
    return { prevState: state, newState, portOps, routeChanges, flapStateChanges: NO_FLAP_CHANGES }
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
      flapStateChanges: NO_FLAP_CHANGES,
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
      flapStateChanges: NO_FLAP_CHANGES,
    }
  }

  private planLocalRouteHealthUpdate(
    data: LocalRouteHealthUpdateData,
    state: RouteTable
  ): PlanResult {
    const idx = state.local.routes.findIndex((r) => r.name === data.name)
    if (idx === -1) return noChange(state)

    const existing = state.local.routes[idx]

    // No-op if health fields are identical (prevent iBGP churn)
    if (
      existing.healthStatus === data.healthStatus &&
      existing.responseTimeMs === data.responseTimeMs &&
      existing.lastChecked === data.lastChecked
    ) {
      return noChange(state)
    }

    const updated = {
      ...existing,
      healthStatus: data.healthStatus,
      responseTimeMs: data.responseTimeMs,
      lastChecked: data.lastChecked,
    }
    const routes = state.local.routes.map((r, i) => (i === idx ? updated : r))
    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: [{ type: 'updated', route: updated }],
      flapStateChanges: NO_FLAP_CHANGES,
    }
  }

  // -------------------------------------------------------------------------
  // Internal protocol handlers
  // -------------------------------------------------------------------------

  private planInternalProtocolOpen(
    data: InternalProtocolOpenData,
    state: RouteTable,
    timestamp: number
  ): PlanResult {
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
      lastReceived: timestamp,
    }
    const peers = state.internal.peers.map((p, i) => (i === idx ? updated : p))
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: NO_ROUTE_CHANGES,
      flapStateChanges: NO_FLAP_CHANGES,
    }
  }

  private planInternalProtocolConnected(
    data: InternalProtocolConnectedData,
    state: RouteTable,
    timestamp: number
  ): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    if (idx === -1) return noChange(state)

    const existing = state.internal.peers[idx]
    // Reset holdTime to default on reconnect so it can be re-negotiated
    // via the subsequent InternalProtocolOpen exchange.
    const updated: PeerRecord = {
      ...existing,
      connectionStatus: 'connected',
      lastConnected: timestamp,
      lastReceived: timestamp,
      holdTime: 90_000,
      lastSent: 0,
    }
    const peers = state.internal.peers.map((p, i) => (i === idx ? updated : p))
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: NO_ROUTE_CHANGES,
      flapStateChanges: NO_FLAP_CHANGES,
    }
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
    return { prevState: state, newState, portOps, routeChanges, flapStateChanges: NO_FLAP_CHANGES }
  }

  private planInternalProtocolUpdate(
    data: InternalProtocolUpdateData,
    state: RouteTable,
    timestamp: number
  ): PlanResult {
    let routes = [...state.internal.routes]
    const portOps: PortOperation[] = []
    const routeChanges: RouteChange[] = []
    const flapChanges: FlapStateChange[] = []

    // Build a transient view of flap state that includes pending changes from
    // this plan, so that multiple updates in the same action see each other's
    // mutations without touching the real _flapState.
    const pendingFlapState = new Map<string, FlapEntry>()

    const getFlapEntry = (key: string): FlapEntry | undefined => {
      return pendingFlapState.get(key) ?? this._flapState.get(key)
    }

    // --- Max prefix limit setup ---
    const limitPeer = state.internal.peers.find((p) => p.name === data.peerInfo.name)
    const prefixLimit = limitPeer?.maxPrefixes ?? 0
    const hasLimit = prefixLimit > 0
    let currentPeerRouteCount = hasLimit
      ? routes.filter((r) => r.peer.name === data.peerInfo.name).length
      : 0

    for (const item of data.update.updates) {
      if (item.action === 'add') {
        // Loop detection — discard advertisements that already include this node
        if (item.nodePath.includes(this._nodeId)) continue

        // --- Max prefix limit check ---
        if (hasLimit && currentPeerRouteCount >= prefixLimit) {
          continue // Drop excess route (Juniper drop-excess model)
        }

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
          const equalPath = item.nodePath.length === existing.nodePath.length
          const replacingStale = existing.isStale === true
          const existingDrained = existing.draining === true
          const newDrained = newRoute.draining === true
          // Non-drained always beats drained, regardless of path length
          const drainingAdvantage = existingDrained && !newDrained
          // Don't replace healthy route with a draining one — but only when received
          // from a different peer (multi-path). Same-peer updates are authoritative
          // (e.g. the origin announcing its own drain).
          const samePeer = existing.peer.name === data.peerInfo.name
          const drainingDisadvantage = !samePeer && !existingDrained && newDrained
          // Same-peer equal-path: accept metadata changes (drain/undrain) from
          // the authoritative source without requiring a strictly better path.
          const samePeerRefresh = samePeer && equalPath
          if (
            !drainingDisadvantage &&
            (betterPath || replacingStale || drainingAdvantage || samePeerRefresh)
          ) {
            routes = routes.map((r, i) => (i === existingIdx ? newRoute : r))
            routeChanges.push({ type: 'updated', route: newRoute })
          }
          // else: existing path is equal or better and fresh — no change
        } else {
          routes = [...routes, newRoute]
          routeChanges.push({ type: 'added', route: newRoute })
          if (hasLimit) currentPeerRouteCount++
        }

        // --- Flap damping: track add-after-remove ---
        const fk = flapKey(routeKey(item.route), item.originNode)
        const flapEntry = getFlapEntry(fk)
        if (flapEntry && flapEntry.penalty > 0) {
          const decayed = this.decayPenalty(flapEntry, timestamp)
          const newPenalty = decayed + FLAP_PENALTY_INCREMENT
          const shouldSuppress = newPenalty >= FLAP_SUPPRESS_THRESHOLD
          const newEntry: FlapEntry = {
            penalty: newPenalty,
            suppressed: shouldSuppress,
            suppressedAt:
              shouldSuppress && !flapEntry.suppressed ? timestamp : flapEntry.suppressedAt,
            lastUpdated: timestamp,
          }
          pendingFlapState.set(fk, newEntry)
          flapChanges.push({ key: fk, entry: newEntry })
        }
      } else {
        // action === 'remove'
        const key = routeKey(item.route)
        const removed = routes.find((r) => routeKey(r) === key && r.originNode === item.originNode)
        if (removed !== undefined) {
          routes = routes.filter((r) => !(routeKey(r) === key && r.originNode === item.originNode))
          routeChanges.push({ type: 'removed', route: removed })
          if (hasLimit) currentPeerRouteCount--
          if (removed.envoyPort != null) {
            portOps.push({ type: 'release', routeKey: key, port: removed.envoyPort })
          }

          // --- Flap damping: mark as recently withdrawn ---
          const fk = flapKey(routeKey(item.route), item.originNode)
          const flapExisting = getFlapEntry(fk)
          let newEntry: FlapEntry
          if (!flapExisting) {
            newEntry = {
              penalty: FLAP_PENALTY_INCREMENT,
              suppressed: false,
              suppressedAt: null,
              lastUpdated: timestamp,
            }
          } else {
            const decayed = this.decayPenalty(flapExisting, timestamp)
            newEntry = {
              ...flapExisting,
              penalty: decayed + FLAP_PENALTY_INCREMENT,
              lastUpdated: timestamp,
            }
          }
          pendingFlapState.set(fk, newEntry)
          flapChanges.push({ key: fk, entry: newEntry })
        }
      }
    }

    // Always update lastReceived on the peer, even when no routes changed
    const peerIdx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    const peers =
      peerIdx !== -1
        ? state.internal.peers.map((p, i) =>
            i === peerIdx ? { ...p, lastReceived: timestamp } : p
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
    return { prevState: state, newState, portOps, routeChanges, flapStateChanges: flapChanges }
  }

  private planInternalProtocolKeepalive(
    data: InternalProtocolKeepaliveData,
    state: RouteTable,
    timestamp: number
  ): PlanResult {
    const idx = state.internal.peers.findIndex((p) => p.name === data.peerInfo.name)
    if (idx === -1) return noChange(state)

    const peers = state.internal.peers.map((p, i) =>
      i === idx ? { ...p, lastReceived: timestamp } : p
    )
    const newState: RouteTable = {
      ...state,
      internal: { ...state.internal, peers },
    }
    return {
      prevState: state,
      newState,
      portOps: NO_PORT_OPS,
      routeChanges: NO_ROUTE_CHANGES,
      flapStateChanges: NO_FLAP_CHANGES,
    }
  }

  // -------------------------------------------------------------------------
  // System handlers
  // -------------------------------------------------------------------------

  private planTick(data: TickData, state: RouteTable): PlanResult {
    // --- Flap damping decay ---
    let flapStateChanged = false
    const flapChanges: FlapStateChange[] = []
    for (const [key, entry] of this._flapState) {
      const decayed = this.decayPenalty(entry, data.now)

      if (decayed < 1) {
        // Penalty negligible — clean up
        flapStateChanged = true
        flapChanges.push({ key, entry: null })
        continue
      }

      const shouldUnsuppress =
        entry.suppressed &&
        (decayed < FLAP_REUSE_THRESHOLD ||
          (entry.suppressedAt != null && data.now - entry.suppressedAt > FLAP_MAX_SUPPRESS_MS))

      if (shouldUnsuppress) {
        const newEntry: FlapEntry = {
          penalty: decayed,
          suppressed: false,
          suppressedAt: null,
          lastUpdated: data.now,
        }
        flapChanges.push({ key, entry: newEntry })
        flapStateChanged = true
      } else if (Math.abs(decayed - entry.penalty) > 0.1) {
        flapChanges.push({ key, entry: { ...entry, penalty: decayed, lastUpdated: data.now } })
      }
    }

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
    if (purgedPeerNames.size === 0 && !flapStateChanged) return noChange(state)

    if (purgedPeerNames.size === 0 && flapStateChanged) {
      const newState: RouteTable = { ...state }
      return {
        prevState: state,
        newState,
        portOps: NO_PORT_OPS,
        routeChanges: NO_ROUTE_CHANGES,
        flapStateChanges: flapChanges,
      }
    }

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
    return { prevState: state, newState, portOps, routeChanges, flapStateChanges: flapChanges }
  }

  private planAdminGracefulShutdown(
    _data: AdminGracefulShutdownData,
    state: RouteTable
  ): PlanResult {
    if (state.local.routes.length === 0) return noChange(state)

    const routes = state.local.routes.map((r) => ({ ...r, draining: true }))
    const routeChanges: RouteChange[] = routes.map((r) => ({ type: 'updated' as const, route: r }))

    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges }
  }

  private planAdminCancelShutdown(_data: AdminCancelShutdownData, state: RouteTable): PlanResult {
    const hasDraining = state.local.routes.some((r) => r.draining === true)
    if (!hasDraining) return noChange(state)

    const routes = state.local.routes.map(({ draining: _draining, ...rest }) => rest)
    const routeChanges: RouteChange[] = routes.map((r) => ({ type: 'updated' as const, route: r }))

    const newState: RouteTable = {
      ...state,
      local: { ...state.local, routes },
    }
    return { prevState: state, newState, portOps: NO_PORT_OPS, routeChanges }
  }
}
