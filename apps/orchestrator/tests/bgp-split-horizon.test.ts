import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * iBGP Split Horizon / Re-advertisement Tests
 *
 * Inspired by GoBGP's ibgp_router_test.py test_03 (the canonical
 * iBGP split-horizon test) and test_16 (multiple iBGP paths: best
 * selected but NOT re-advertised to other iBGP peers), and
 * TestFilterpathWithiBGP from server_test.go.
 *
 * In iBGP, routes learned from one iBGP peer should not be blindly
 * re-advertised. Our implementation uses nodePath filtering to
 * prevent sending routes back through peers already in the path.
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

describe('iBGP Split Horizon / Re-advertisement', () => {
  it('local routes are always propagated to all connected peers', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    const result = planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

    // Both B and C should receive the local route
    const updates = result.propagations.filter((p) => p.type === 'update')
    expect(updates).toHaveLength(2)
    const peerNames = updates.map((p) => p.peer.name).sort()
    expect(peerNames).toEqual([PEER_B.name, PEER_C.name])
  })

  it('full sync on peer connect excludes routes with target peer in nodePath', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add a local route and an internal route from B that has C in its path
    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'local-svc', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-from-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
              nodePath: [PEER_B.name, PEER_C.name], // C is in the path
            },
          ],
        },
      },
    })

    // Now connect C — full sync should NOT include svc-from-b (C is in nodePath)
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_C })
    const openResult = planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_C },
    })

    const syncProps = openResult.propagations.filter((p) => p.type === 'update')
    expect(syncProps).toHaveLength(1)

    if (syncProps[0].type === 'update') {
      const routeNames = syncProps[0].update.updates.map((u) => u.route.name)
      // Should contain local-svc but NOT svc-from-b
      expect(routeNames).toContain('local-svc')
      expect(routeNames).not.toContain('svc-from-b')
    }
  })

  it('nodePath is prepended with this node on re-advertisement', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    const result = planCommit(rib, {
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

    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      // nodePath should be [NODE, PEER_B] — our name prepended
      expect(toC.update.updates[0].nodePath).toEqual([NODE.name, PEER_B.name])
    }
  })

  it('remove actions are always propagated (not subject to nodePath filtering)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // First add routes from B that have C in path
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
              nodePath: [PEER_B.name, PEER_C.name],
            },
          ],
        },
      },
    })

    // Now remove it — removal should go to C even though C was in the original nodePath
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
    }
  })

  it('source peer is never included in re-advertisement propagations', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    const result = planCommit(rib, {
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

    // B should never receive its own update back
    const toB = result.propagations.filter(
      (p) => p.type === 'update' && p.peer.name === PEER_B.name
    )
    expect(toB).toHaveLength(0)

    // Only C should get it
    const toC = result.propagations.filter(
      (p) => p.type === 'update' && p.peer.name === PEER_C.name
    )
    expect(toC).toHaveLength(1)
  })
})
