import { describe, it, expect } from 'vitest'
import { RoutingInformationBase, Actions, newRouteTable } from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo, Action } from '@catalyst/routing/v2'

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

  it('drained route does NOT replace a healthy route', () => {
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

    // Now receive the same route but with draining — should NOT replace
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

    // No route changes — the healthy route is kept
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
})
