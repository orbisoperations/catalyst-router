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

function stateWithPeer(): RouteTable {
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

const NOW = 5000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enforce-first-as origin validation (RFC 4271 §6.3)', () => {
  it('accepts valid single-hop route where nodePath[0] and originNode match peer', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer()

    const action: Action = {
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

    const plan = rib.plan(action, state, NOW)

    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('added')
    expect(plan.newState.internal.routes).toHaveLength(1)
  })

  it('discards route when nodePath[0] does not match peer', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer()

    const action: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              // nodePath[0] is "node-c", but peer is "node-b" — spoofed first hop
              nodePath: ['node-c', 'node-b'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }

    const plan = rib.plan(action, state, NOW)

    expect(plan.routeChanges).toHaveLength(0)
    expect(plan.newState.internal.routes).toHaveLength(0)
  })

  it('discards single-hop route when originNode does not match peer', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer()

    const action: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              // nodePath[0] matches peer, but originNode claims to be someone else
              nodePath: ['node-b'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }

    const plan = rib.plan(action, state, NOW)

    expect(plan.routeChanges).toHaveLength(0)
    expect(plan.newState.internal.routes).toHaveLength(0)
  })

  it('accepts valid multi-hop route where nodePath[0] matches peer and originNode differs', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer()

    const action: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-1'),
              // node-b forwarding a route that originated at node-c
              nodePath: ['node-b', 'node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }

    const plan = rib.plan(action, state, NOW)

    expect(plan.routeChanges).toHaveLength(1)
    expect(plan.routeChanges[0].type).toBe('added')
    expect(plan.newState.internal.routes).toHaveLength(1)
    expect(plan.newState.internal.routes[0].originNode).toBe('node-c')
  })

  it('discards withdrawal when nodePath[0] does not match peer', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer()

    // First, install a valid route from node-b
    const addAction: Action = {
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
    const addPlan = rib.plan(addAction, state, NOW)
    rib.commit(addPlan, addAction)

    expect(rib.state.internal.routes).toHaveLength(1)

    // Now attempt a spoofed withdrawal where nodePath[0] != peer
    const removeAction: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'remove' as const,
              route: makeRoute('svc-1'),
              // Spoofed: nodePath[0] claims to be node-c, but sender is node-b
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }

    const removePlan = rib.plan(removeAction, rib.state, NOW)

    // Route should still be present — spoofed withdrawal was discarded
    expect(removePlan.routeChanges).toHaveLength(0)
    expect(removePlan.newState.internal.routes).toHaveLength(1)
  })
})
