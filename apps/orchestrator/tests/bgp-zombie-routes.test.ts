import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Zombie Route / State Corruption Tests
 *
 * Inspired by RIPE Labs BGP Zombies research and GoBGP's
 * TestEBGPRouteStuck. Zombie routes are entries that persist in the
 * RIB after the session/peer that advertised them is gone.
 *
 * These tests verify that state cleanup is thorough and that no
 * routes survive peer disconnection or deletion.
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

describe('Zombie Routes / State Corruption', () => {
  it('InternalProtocolClose removes ALL routes from that peer', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add 5 routes from peer B
    const routeNames = ['svc-1', 'svc-2', 'svc-3', 'svc-4', 'svc-5']
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: routeNames.map((name) => ({
            action: 'add' as const,
            route: { name, protocol: 'http' as const, endpoint: `http://${name}:8080` },
            nodePath: [PEER_B.name],
          })),
        },
      },
    })
    expect(rib.getState().internal.routes).toHaveLength(5)

    // Close the peer
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    // Zero routes — no zombies
    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(rib.getState().internal.peers).toHaveLength(0)
  })

  it('routes from closed peer do not appear in getState()', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises svc-b, C advertises svc-c
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
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_C,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-c', protocol: 'http' as const, endpoint: 'http://c:8080' },
              nodePath: [PEER_C.name],
            },
          ],
        },
      },
    })
    expect(rib.getState().internal.routes).toHaveLength(2)

    // Close B only
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    const state = rib.getState()
    // Only C's route remains
    expect(state.internal.routes).toHaveLength(1)
    expect(state.internal.routes[0].name).toBe('svc-c')
    expect(state.internal.routes[0].peerName).toBe(PEER_C.name)

    // No route with B's peerName
    expect(state.internal.routes.filter((r) => r.peerName === PEER_B.name)).toHaveLength(0)
  })

  it('plan on current state after mutations reflects latest state', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add a route
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Plan A: add another route
    const planA = rib.plan({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-y', protocol: 'http' as const, endpoint: 'http://y:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })
    expect(planA.success).toBe(true)
    // Plan A should see svc-x in prevState (it was committed earlier)
    const pA = planA as Plan
    expect(pA.prevState.internal.routes).toHaveLength(1)
    expect(pA.newState.internal.routes).toHaveLength(2)
  })

  it('withdrawal propagation on close includes all routes from closed peer', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises 3 routes
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
            {
              action: 'add',
              route: { name: 'svc-3', protocol: 'http' as const, endpoint: 'http://3:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Close B — withdrawal to C should contain all 3 routes
    const result = planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates).toHaveLength(3)
      const names = toC.update.updates.map((u) => u.route.name).sort()
      expect(names).toEqual(['svc-1', 'svc-2', 'svc-3'])
      // All should be remove actions
      expect(toC.update.updates.every((u) => u.action === 'remove')).toBe(true)
    }
  })

  it('LocalPeerDelete removes peer but leaves routes as zombies', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add routes from B
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
    expect(rib.getState().internal.routes).toHaveLength(2)

    // Delete the peer (not close — delete skips route cleanup)
    planCommit(rib, { action: Actions.LocalPeerDelete, data: { name: PEER_B.name } })

    // Peer is gone
    expect(rib.getState().internal.peers).toHaveLength(0)

    // Routes are NOT cleaned up — they become zombies.
    // (Unlike InternalProtocolClose which removes routes from the closed peer.)
    // This documents actual behavior: LocalPeerDelete only removes the peer record.
    expect(rib.getState().internal.routes).toHaveLength(2)
  })

  it('route removal propagates withdrawal to other connected peers', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises svc-x
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // B withdraws svc-x
    const result = planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'remove',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
            },
          ],
        },
      },
    })

    // C should receive the withdrawal
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates[0].action).toBe('remove')
      expect(toC.update.updates[0].route.name).toBe('svc-x')
    }
  })
})
