import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Multi-Route Batch Update Tests
 *
 * Inspired by FRRouting's bgp_batch_clearing topotest (100K route
 * insertion then bulk withdrawal) and GoBGP's
 * TestDestination_Calculate_AddAndWithdrawPath.
 *
 * Real BGP peers send batched UPDATE messages with multiple NLRI
 * entries. All existing tests use single-route updates. These tests
 * verify correct processing of multi-route batches.
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

describe('Multi-Route Batch Updates', () => {
  it('batch add: multiple routes in a single update all added to state', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

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

    const routes = rib.getState().internal.routes
    expect(routes).toHaveLength(3)
    expect(routes.map((r) => r.name).sort()).toEqual(['svc-1', 'svc-2', 'svc-3'])
  })

  it('batch remove: multiple routes in a single update all removed', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add 3 routes
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
    expect(rib.getState().internal.routes).toHaveLength(3)

    // Remove all 3 in one message
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'remove',
              route: { name: 'svc-1', protocol: 'http' as const, endpoint: 'http://1:8080' },
            },
            {
              action: 'remove',
              route: { name: 'svc-2', protocol: 'http' as const, endpoint: 'http://2:8080' },
            },
            {
              action: 'remove',
              route: { name: 'svc-3', protocol: 'http' as const, endpoint: 'http://3:8080' },
            },
          ],
        },
      },
    })

    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('batch propagation: downstream peers receive all routes in a single propagation', () => {
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

    // C should receive ONE propagation message with BOTH routes
    const toC = result.propagations.filter(
      (p) => p.type === 'update' && p.peer.name === PEER_C.name
    )
    expect(toC).toHaveLength(1)
    if (toC[0].type === 'update') {
      expect(toC[0].update.updates).toHaveLength(2)
    }
  })

  it('partial loop filtering in batch: looped routes dropped, safe routes propagated', () => {
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
              route: { name: 'safe-1', protocol: 'http' as const, endpoint: 'http://1:8080' },
              nodePath: [PEER_B.name],
            },
            {
              action: 'add',
              route: { name: 'looped', protocol: 'http' as const, endpoint: 'http://2:8080' },
              nodePath: [PEER_B.name, NODE.name], // Contains our node — loop!
            },
            {
              action: 'add',
              route: { name: 'safe-2', protocol: 'http' as const, endpoint: 'http://3:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Only 2 routes in state (looped one dropped)
    const routes = rib.getState().internal.routes
    expect(routes).toHaveLength(2)
    expect(routes.map((r) => r.name).sort()).toEqual(['safe-1', 'safe-2'])

    // Propagation to C should only contain the 2 safe routes
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates).toHaveLength(2)
      const names = toC.update.updates.map((u) => u.route.name).sort()
      expect(names).toEqual(['safe-1', 'safe-2'])
    }
  })
})
