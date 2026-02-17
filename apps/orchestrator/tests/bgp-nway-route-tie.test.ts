import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * N-Way Route Tie Tests
 *
 * When multiple peers advertise the same route with equal-length
 * nodePaths, the RIB must store all of them and maintain correct
 * metadata (bestPath + alternatives). Inspired by GoBGP TestMultipath.
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

describe('N-Way Route Tie', () => {
  it('3 peers with equal-length nodePaths: all stored, correct alternatives count', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)
    connectPeer(rib, PEER_D)

    for (const peer of [PEER_B, PEER_C, PEER_D]) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peer,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'svc-x',
                  protocol: 'http' as const,
                  endpoint: `http://${peer.name}:8080`,
                },
                nodePath: [peer.name],
              },
            ],
          },
        },
      })
    }

    const routes = rib.getState().internal.routes.filter((r) => r.name === 'svc-x')
    expect(routes).toHaveLength(3)

    const meta = rib.getRouteMetadata().get('svc-x')
    expect(meta).toBeDefined()
    expect(meta!.alternatives).toHaveLength(2)
  })

  it('withdrawal from 3-way tie reduces alternatives by one', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)
    connectPeer(rib, PEER_D)

    for (const peer of [PEER_B, PEER_C, PEER_D]) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peer,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'svc-x',
                  protocol: 'http' as const,
                  endpoint: `http://${peer.name}:8080`,
                },
                nodePath: [peer.name],
              },
            ],
          },
        },
      })
    }

    // Withdraw B
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [{ action: 'remove', route: { name: 'svc-x', protocol: 'http' as const } }],
        },
      },
    })

    const meta = rib.getRouteMetadata().get('svc-x')
    expect(meta).toBeDefined()
    expect(meta!.alternatives).toHaveLength(1)
  })

  it('all peers withdraw: route metadata cleaned up', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    for (const peer of [PEER_B, PEER_C]) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peer,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'svc-x',
                  protocol: 'http' as const,
                  endpoint: `http://${peer.name}:8080`,
                },
                nodePath: [peer.name],
              },
            ],
          },
        },
      })
    }

    for (const peer of [PEER_B, PEER_C]) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peer,
          update: {
            updates: [{ action: 'remove', route: { name: 'svc-x', protocol: 'http' as const } }],
          },
        },
      })
    }

    expect(rib.getState().internal.routes.filter((r) => r.name === 'svc-x')).toHaveLength(0)
    expect(rib.getRouteMetadata().has('svc-x')).toBe(false)
  })
})
