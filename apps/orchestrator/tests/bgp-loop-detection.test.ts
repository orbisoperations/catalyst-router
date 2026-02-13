import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Loop Detection Tests
 *
 * Inspired by GoBGP's TestCheckOwnASLoop and FRRouting's
 * bgp_sender_as_path_loop_detection topotest. In BGP, the AS_PATH
 * attribute is scanned for the local AS number to prevent routing
 * loops. Our iBGP adaptation uses nodePath for the same purpose.
 *
 * These tests verify that:
 * 1. Routes with our own node name anywhere in nodePath are dropped
 * 2. Routes are not re-advertised to peers already in the nodePath
 * 3. Empty nodePath is valid (freshly originated routes)
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

const PEER_D: PeerInfo = {
  name: 'node-d.somebiz.local.io',
  endpoint: 'http://node-d:3000',
  domains: ['somebiz.local.io'],
  peerToken: 'token-for-d',
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

function injectRoute(
  rib: RoutingInformationBase,
  peer: PeerInfo,
  route: { name: string; protocol: 'http'; endpoint: string },
  nodePath: string[]
) {
  return planCommit(rib, {
    action: Actions.InternalProtocolUpdate,
    data: {
      peerInfo: peer,
      update: {
        updates: [{ action: 'add', route, nodePath }],
      },
    },
  })
}

describe('Loop Detection', () => {
  it('drops route when own node appears at end of multi-hop nodePath', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // nodePath: [PEER_B, some-other, NODE] — our node is at the end (looped back)
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
      'node-other.somebiz.local.io',
      NODE.name,
    ])

    // Route should be dropped — loop detected
    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('drops route when own node appears at start of nodePath', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // nodePath: [NODE, PEER_B] — our node somehow at start
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      NODE.name,
      PEER_B.name,
    ])

    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('accepts route with empty nodePath (freshly originated)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Empty nodePath is valid for a freshly originated route
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [])

    expect(rib.getState().internal.routes).toHaveLength(1)
    expect(rib.getState().internal.routes[0].nodePath).toEqual([])
  })

  it('does not re-advertise route to peer already in nodePath (split-horizon)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // PEER_B sends a route that originally came through PEER_C
    // nodePath: [PEER_B, PEER_C] — PEER_C is in the path
    const result = planCommit(rib, {
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

    // Route should be stored (it doesn't contain our node)
    expect(rib.getState().internal.routes).toHaveLength(1)

    // But propagation to PEER_C should be filtered out (PEER_C is in nodePath)
    const updateProps = result.propagations.filter((p) => p.type === 'update')
    for (const prop of updateProps) {
      expect(prop.peer.name).not.toBe(PEER_C.name)
    }
  })

  it('produces zero propagations when all target peers are in nodePath', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // PEER_B sends route with PEER_C in path. The only other peer is PEER_C.
    // After excluding source (PEER_B) and loop-filtered (PEER_C), no peers left.
    const result = planCommit(rib, {
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

    expect(result.propagations).toHaveLength(0)
  })

  it('loop detection is per-update: safe routes in same batch still propagate', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)
    connectPeer(rib, PEER_D)

    // PEER_B sends two routes:
    // svc-x has PEER_C in path (should not go to C, but should go to D)
    // svc-y has clean path (should go to both C and D)
    const result = planCommit(rib, {
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
            {
              action: 'add',
              route: { name: 'svc-y', protocol: 'http' as const, endpoint: 'http://y:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Both routes should be in state (neither contains our node)
    expect(rib.getState().internal.routes).toHaveLength(2)

    // D should get both routes
    const toD = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_D.name)
    expect(toD).toBeDefined()
    if (toD && toD.type === 'update') {
      expect(toD.update.updates).toHaveLength(2)
    }

    // C should only get svc-y (svc-x has C in nodePath)
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates).toHaveLength(1)
      expect(toC.update.updates[0].route.name).toBe('svc-y')
    }
  })
})
