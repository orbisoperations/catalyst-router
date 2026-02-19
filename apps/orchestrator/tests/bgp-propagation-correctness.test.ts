import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Propagation Correctness Tests
 *
 * Inspired by FRRouting's bgp_conditional_advertisement topotest and
 * OpenBGPD's eval_all.sh integration tests.
 *
 * These tests verify that propagations are sent only to appropriate
 * peers, that various action types produce the correct propagation
 * messages, and that edge cases in propagation targeting are handled.
 */

const NODE: PeerInfo = {
  name: 'node-a.somebiz.local.io',
  endpoint: 'http://node-a:3000',
  domains: ['somebiz.local.io'],
}

const PEER_B: PeerInfo = {
  name: 'node-b.somebiz.local.io',
  endpoint: 'http://node-b:3000',
  domains: ['somebiz.local.io'],
  peerToken: 'token-for-b',
}

const PEER_C: PeerInfo = {
  name: 'node-c.somebiz.local.io',
  endpoint: 'http://node-c:3000',
  domains: ['somebiz.local.io'],
  peerToken: 'token-for-c',
}

const CONFIG: OrchestratorConfig = { node: NODE }

function createRib() {
  return new RoutingInformationBase(CONFIG)
}

function planCommit(rib: RoutingInformationBase, action: Parameters<typeof rib.plan>[0]) {
  const plan = rib.plan(action)
  if (!plan.success) throw new Error(`plan failed: ${plan.error}`)
  return rib.commit(plan)
}

function connectPeer(rib: RoutingInformationBase, peer: PeerInfo) {
  planCommit(rib, { action: Actions.LocalPeerCreate, data: peer })
  planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: peer } })
}

function setPeerTimingFields(
  rib: RoutingInformationBase,
  peerName: string,
  fields: { lastReceived?: number; lastSent?: number; holdTime?: number }
) {
  const state = rib.getState()
  const updatedPeers = state.internal.peers.map((p) =>
    p.name === peerName ? { ...p, ...fields } : p
  )
  const newState = {
    ...state,
    internal: { ...state.internal, peers: updatedPeers },
  }
  rib.commit({
    success: true,
    action: { action: Actions.Tick, data: { now: 0 } },
    prevState: state,
    newState,
    portOperations: [],
    routeMetadata: new Map(),
  })
}

describe('Propagation Correctness', () => {
  it('only connected peers receive propagations (initializing peers skipped)', () => {
    const rib = createRib()

    // Create B but don't open (stays initializing)
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    // Create and open C (connected)
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_C })
    planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: PEER_C } })

    // Verify B is initializing, C is connected
    const peers = rib.getState().internal.peers
    expect(peers.find((p) => p.name === PEER_B.name)!.connectionStatus).toBe('initializing')
    expect(peers.find((p) => p.name === PEER_C.name)!.connectionStatus).toBe('connected')

    // Add a local route — should only propagate to C
    const result = planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    const updates = result.propagations.filter((p) => p.type === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].peer.name).toBe(PEER_C.name)
  })

  it('LocalRouteDelete sends remove to all connected peers', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // Add a local route
    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    // Delete the local route
    const result = planCommit(rib, {
      action: Actions.LocalRouteDelete,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    // Both peers should receive removal
    const updates = result.propagations.filter((p) => p.type === 'update')
    expect(updates).toHaveLength(2)
    const peerNames = updates.map((p) => p.peer.name).sort()
    expect(peerNames).toEqual([PEER_B.name, PEER_C.name])

    // Each should have a remove action
    for (const update of updates) {
      if (update.type === 'update') {
        expect(update.update.updates).toHaveLength(1)
        expect(update.update.updates[0].action).toBe('remove')
        expect(update.update.updates[0].route.name).toBe('local-svc')
      }
    }
  })

  it('tick withdrawal targets surviving peers, not expired ones', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises a route
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Set B to expire (old lastReceived), C stays healthy
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })
    setPeerTimingFields(rib, PEER_C.name, {
      holdTime: 60,
      lastReceived: 60_000,
      lastSent: 60_000,
    })

    // Tick — B expires, C gets withdrawal
    const plan = rib.plan({ action: Actions.Tick, data: { now: 62_000 } })
    expect(plan.success).toBe(true)

    const result = rib.commit(plan as Plan)
    const updates = result.propagations.filter((p) => p.type === 'update')

    // Withdrawal should go to C, not to the expired B
    expect(updates).toHaveLength(1)
    expect(updates[0].peer.name).toBe(PEER_C.name)
  })

  it('no propagation when zero connected peers', () => {
    const rib = createRib()

    // Add a local route with no peers at all
    const result = planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    // Zero propagations
    expect(result.propagations).toHaveLength(0)
  })

  it('InternalProtocolClose withdrawal content includes all routes from closed peer', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises 2 routes
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-1', protocol: 'http' as const, endpoint: 'http://1:8080' },
              nodePath: [PEER_B.name],
            },
            {
              action: 'add',
              route: { name: 'svc-2', protocol: 'http' as const, endpoint: 'http://2:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Close B
    const result = planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    // C should receive withdrawal of both routes
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates).toHaveLength(2)
      expect(toC.update.updates.every((u) => u.action === 'remove')).toBe(true)
      const names = toC.update.updates.map((u) => u.route.name).sort()
      expect(names).toEqual(['svc-1', 'svc-2'])
    }
  })
})
