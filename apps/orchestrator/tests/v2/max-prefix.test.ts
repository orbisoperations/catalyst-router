import { describe, it, expect } from 'vitest'
import { RoutingInformationBase, Actions, newRouteTable } from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }

function makeRoute(name: string) {
  return { name, protocol: 'http' as const, endpoint: `http://${name}:8080` }
}

function stateWithPeer(maxPrefixes?: number): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    maxPrefixes,
  }
  state.internal.peers = [peer]
  return state
}

function makeUpdate(names: string[], action: 'add' | 'remove' = 'add') {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: names.map((name) => ({
          action,
          route: makeRoute(name),
          nodePath: ['node-b'],
          originNode: 'node-b',
        })),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('max prefix limits (drop-excess model)', () => {
  it('accepts routes up to exactly the limit', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(3)
    const action = makeUpdate(['svc-1', 'svc-2', 'svc-3'])

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(3)
    expect(plan.newState.internal.routes).toHaveLength(3)
  })

  it('drops excess routes individually', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(3)
    const action = makeUpdate(['svc-1', 'svc-2', 'svc-3', 'svc-4', 'svc-5'])

    const plan = rib.plan(action, state)

    const added = plan.routeChanges.filter((c) => c.type === 'added')
    expect(added).toHaveLength(3)
    expect(added.map((c) => c.route.name)).toEqual(['svc-1', 'svc-2', 'svc-3'])
    expect(plan.newState.internal.routes).toHaveLength(3)
  })

  it('remove below limit then add more succeeds', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Fill to limit of 3
    const state = stateWithPeer(3)
    const fillAction = makeUpdate(['svc-1', 'svc-2', 'svc-3'])
    const fillPlan = rib.plan(fillAction, state)
    rib.commit(fillPlan, fillAction)

    // Remove one route
    const removeAction = makeUpdate(['svc-2'], 'remove')
    const removePlan = rib.plan(removeAction, rib.state)
    rib.commit(removePlan, removeAction)

    expect(rib.state.internal.routes).toHaveLength(2)

    // Add two new routes — only 1 should be accepted (back to limit of 3)
    const addAction = makeUpdate(['svc-4', 'svc-5'])
    const addPlan = rib.plan(addAction, rib.state)

    const added = addPlan.routeChanges.filter((c) => c.type === 'added')
    expect(added).toHaveLength(1)
    expect(added[0].route.name).toBe('svc-4')
  })

  it('maxPrefixes: 0 means unlimited', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(0)
    const names = Array.from({ length: 100 }, (_, i) => `svc-${i}`)
    const action = makeUpdate(names)

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(100)
    expect(plan.newState.internal.routes).toHaveLength(100)
  })

  it('peer with no maxPrefixes set works unchanged', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(undefined)
    const names = Array.from({ length: 50 }, (_, i) => `svc-${i}`)
    const action = makeUpdate(names)

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(50)
    expect(plan.newState.internal.routes).toHaveLength(50)
  })

  it('count is per-peer', () => {
    const rib = new RoutingInformationBase({ nodeId })

    const peerC: PeerInfo = { name: 'node-c', endpoint: 'ws://c:4000', domains: ['test.local'] }

    const state = newRouteTable()
    const peerBRecord: PeerRecord = {
      ...peerB,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    }
    const peerCRecord: PeerRecord = {
      ...peerC,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    }
    state.internal.peers = [peerBRecord, peerCRecord]

    // Fill peer B: send 3, expect 2 accepted
    const fillB = makeUpdate(['svc-1', 'svc-2', 'svc-3'])
    const planB = rib.plan(fillB, state)
    rib.commit(planB, fillB)

    const addedB = planB.routeChanges.filter((c) => c.type === 'added')
    expect(addedB).toHaveLength(2)

    // Peer C should still be able to add routes
    const fillC = {
      action: Actions.InternalProtocolUpdate as const,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-from-c'),
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }
    const planC = rib.plan(fillC, rib.state)

    const addedC = planC.routeChanges.filter((c) => c.type === 'added')
    expect(addedC).toHaveLength(1)
    expect(addedC[0].route.name).toBe('svc-from-c')
  })
})
