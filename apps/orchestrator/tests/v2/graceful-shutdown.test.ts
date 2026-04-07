import { describe, it, expect } from 'vitest'
import { RoutingInformationBase, Actions, newRouteTable } from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo, Action } from '@catalyst/routing/v2'
import { TopologyHelper } from './helpers/topology-helper.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }

function makeRoute(name: string) {
  return { name, protocol: 'http' as const, endpoint: `http://${name}:8080` }
}

function connectedState(): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    consecutiveFailures: 0,
    lastFailure: 0,
    syncDeferredUntil: 0,
  }
  state.internal.peers = [peer]
  return state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graceful shutdown — drain signal', () => {
  it('marks all local routes as draining', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Create two local routes
    const create1: Action = { action: Actions.LocalRouteCreate, data: makeRoute('svc-1') }
    const p1 = rib.plan(create1, rib.state)
    rib.commit(p1, create1)

    const create2: Action = { action: Actions.LocalRouteCreate, data: makeRoute('svc-2') }
    const p2 = rib.plan(create2, rib.state)
    rib.commit(p2, create2)

    expect(rib.state.local.routes).toHaveLength(2)

    // Dispatch graceful shutdown
    const shutdown: Action = { action: Actions.AdminGracefulShutdown, data: {} }
    const plan = rib.plan(shutdown, rib.state)

    // All local routes should be marked draining
    expect(plan.newState.local.routes).toHaveLength(2)
    for (const route of plan.newState.local.routes) {
      expect(route.draining).toBe(true)
    }

    // Route changes should report 2 updated entries
    expect(plan.routeChanges).toHaveLength(2)
    for (const change of plan.routeChanges) {
      expect(change.type).toBe('updated')
    }
  })

  it('peers deprioritize drained routes — non-drained wins', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Add a drained internal route from peer-B
    const addDrained: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: { ...makeRoute('svc-1'), draining: true },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    }
    const p1 = rib.plan(addDrained, state)
    rib.commit(p1, addDrained)

    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBe(true)

    // Now receive the same route without draining — should replace the drained version
    const addHealthy: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    }
    const p2 = rib.plan(addHealthy, rib.state)

    // The route should be updated (non-drained replaces drained)
    const updated = p2.routeChanges.filter((c) => c.type === 'updated')
    expect(updated).toHaveLength(1)
    expect(updated[0].route.draining).toBeUndefined()

    // After commit, the route should not be draining
    rib.commit(p2, addHealthy)
    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBeUndefined()
  })

  it('same-peer drain update is accepted (authoritative)', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Add a healthy (non-drained) internal route from peer-B
    const addHealthy: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    }
    const p1 = rib.plan(addHealthy, state)
    rib.commit(p1, addHealthy)

    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBeUndefined()

    // Same peer sends a drain update — should be accepted (same peer is authoritative)
    const addDrained: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: { ...makeRoute('svc-1'), draining: true },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    }
    const p2 = rib.plan(addDrained, rib.state)

    // The route should be updated (same peer announcing drain)
    const updated = p2.routeChanges.filter((c) => c.type === 'updated')
    expect(updated).toHaveLength(1)
    expect(updated[0].route.draining).toBe(true)

    // After commit, the route should be draining
    rib.commit(p2, addDrained)
    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBe(true)
  })

  it('drained route via different peer does NOT replace healthy route', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Set up state with two peers
    const peerC: PeerInfo = { name: 'node-c', endpoint: 'ws://c:4000', domains: ['test.local'] }
    const state = newRouteTable()
    const peerBRecord: PeerRecord = {
      ...peerB,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      consecutiveFailures: 0,
      lastFailure: 0,
      syncDeferredUntil: 0,
    }
    const peerCRecord: PeerRecord = {
      ...peerC,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      consecutiveFailures: 0,
      lastFailure: 0,
      syncDeferredUntil: 0,
    }
    state.internal.peers = [peerBRecord, peerCRecord]

    // Receive healthy route from peer-B (origin: node-x)
    const addHealthy: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              nodePath: ['node-b', 'node-x'],
              originNode: 'node-x',
            },
          ],
        },
      },
    }
    const p1 = rib.plan(addHealthy, state)
    rib.commit(p1, addHealthy)

    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBeUndefined()

    // Receive drained version of same route from different peer-C (same origin: node-x)
    const addDrained: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: { ...makeRoute('svc-1'), draining: true },
              nodePath: ['node-c', 'node-x'],
              originNode: 'node-x',
            },
          ],
        },
      },
    }
    const p2 = rib.plan(addDrained, rib.state)

    // No route changes — the healthy route from the other peer path is kept
    const updated = p2.routeChanges.filter((c) => c.type === 'updated')
    expect(updated).toHaveLength(0)

    // After commit, the route should still not be draining
    rib.commit(p2, addDrained)
    expect(rib.state.internal.routes).toHaveLength(1)
    expect(rib.state.internal.routes[0].draining).toBeUndefined()
  })

  it('cancel removes drain marker', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Create two local routes
    const create1: Action = { action: Actions.LocalRouteCreate, data: makeRoute('svc-1') }
    const p1 = rib.plan(create1, rib.state)
    rib.commit(p1, create1)

    const create2: Action = { action: Actions.LocalRouteCreate, data: makeRoute('svc-2') }
    const p2 = rib.plan(create2, rib.state)
    rib.commit(p2, create2)

    // Dispatch graceful shutdown
    const shutdown: Action = { action: Actions.AdminGracefulShutdown, data: {} }
    const shutdownPlan = rib.plan(shutdown, rib.state)
    rib.commit(shutdownPlan, shutdown)

    // Verify routes are draining
    for (const route of rib.state.local.routes) {
      expect(route.draining).toBe(true)
    }

    // Dispatch cancel shutdown
    const cancel: Action = { action: Actions.AdminCancelShutdown, data: {} }
    const cancelPlan = rib.plan(cancel, rib.state)

    // Route changes should report 2 updated entries
    expect(cancelPlan.routeChanges).toHaveLength(2)
    for (const change of cancelPlan.routeChanges) {
      expect(change.type).toBe('updated')
    }

    // After commit, routes should no longer have draining
    rib.commit(cancelPlan, cancel)
    for (const route of rib.state.local.routes) {
      expect(route.draining).toBeUndefined()
    }
    expect(rib.state.local.routes).toHaveLength(2)
  })

  it('shutdown is idempotent — second dispatch is a no-op', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Create a local route
    const create: Action = { action: Actions.LocalRouteCreate, data: makeRoute('svc-1') }
    const p1 = rib.plan(create, rib.state)
    rib.commit(p1, create)

    // First shutdown — should produce route changes
    const shutdown: Action = { action: Actions.AdminGracefulShutdown, data: {} }
    const plan1 = rib.plan(shutdown, rib.state)
    expect(rib.stateChanged(plan1)).toBe(true)
    expect(plan1.routeChanges).toHaveLength(1)
    rib.commit(plan1, shutdown)

    // Second shutdown — already draining, should be a no-op
    const plan2 = rib.plan(shutdown, rib.state)
    expect(rib.stateChanged(plan2)).toBe(false)
    expect(plan2.routeChanges).toHaveLength(0)
  })

  it('shutdown with zero local routes is a no-op', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // No local routes — shutdown should be a no-op
    expect(rib.state.local.routes).toHaveLength(0)

    const shutdown: Action = { action: Actions.AdminGracefulShutdown, data: {} }
    const plan = rib.plan(shutdown, rib.state)
    expect(rib.stateChanged(plan)).toBe(false)
    expect(plan.routeChanges).toHaveLength(0)
    expect(plan.portOps).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Topology tests for graceful shutdown
// ---------------------------------------------------------------------------

describe('Graceful shutdown topology', () => {
  it('A drains -> C prefers B; A cancels -> C accepts A again', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    // Setup: A<->C and B<->C (no direct A<->B link)
    await topo.peer('node-a', 'node-c')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    // Both A and B create the same local route 'shared-svc'
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('shared-svc'),
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('shared-svc'),
    })

    // Propagate A->C and B->C. C should have the route from both peers.
    await topo.propagate('node-a', 'node-c')
    await topo.propagate('node-b', 'node-c')

    const cRoutes = topo.get('node-c').bus.state.internal.routes
    expect(cRoutes).toHaveLength(2)

    const fromA = cRoutes.find((r) => r.originNode === 'node-a')
    const fromB = cRoutes.find((r) => r.originNode === 'node-b')
    expect(fromA).toBeDefined()
    expect(fromB).toBeDefined()
    expect(fromA!.draining).toBeUndefined()
    expect(fromB!.draining).toBeUndefined()
    topo.resetAll()

    // ---------------------------------------------------------------
    // Phase 1: A dispatches AdminGracefulShutdown
    // ---------------------------------------------------------------
    await topo.get('node-a').bus.dispatch({
      action: Actions.AdminGracefulShutdown,
      data: {},
    })

    // A's local routes should be draining
    expect(topo.get('node-a').bus.state.local.routes[0].draining).toBe(true)

    // Propagate the drained update A->C
    await topo.propagate('node-a', 'node-c')

    const cRoutesAfterDrain = topo.get('node-c').bus.state.internal.routes
    expect(cRoutesAfterDrain).toHaveLength(2)

    const fromADrained = cRoutesAfterDrain.find((r) => r.originNode === 'node-a')
    const fromBHealthy = cRoutesAfterDrain.find((r) => r.originNode === 'node-b')
    expect(fromADrained).toBeDefined()
    expect(fromBHealthy).toBeDefined()

    // A's route on C should now be draining
    expect(fromADrained!.draining).toBe(true)
    // B's route on C should remain healthy
    expect(fromBHealthy!.draining).toBeUndefined()

    topo.resetAll()

    // ---------------------------------------------------------------
    // Phase 2: A dispatches AdminCancelShutdown
    // ---------------------------------------------------------------
    await topo.get('node-a').bus.dispatch({
      action: Actions.AdminCancelShutdown,
      data: {},
    })

    // A's local routes should no longer be draining
    expect(topo.get('node-a').bus.state.local.routes[0].draining).toBeUndefined()

    // Propagate the undrained update A->C
    await topo.propagate('node-a', 'node-c')

    const cRoutesAfterCancel = topo.get('node-c').bus.state.internal.routes
    expect(cRoutesAfterCancel).toHaveLength(2)

    const fromARestored = cRoutesAfterCancel.find((r) => r.originNode === 'node-a')
    const fromBStillHealthy = cRoutesAfterCancel.find((r) => r.originNode === 'node-b')
    expect(fromARestored).toBeDefined()
    expect(fromBStillHealthy).toBeDefined()

    // A's route on C should no longer be draining
    expect(fromARestored!.draining).toBeUndefined()
    // B's route on C should still be healthy
    expect(fromBStillHealthy!.draining).toBeUndefined()
  })
})
