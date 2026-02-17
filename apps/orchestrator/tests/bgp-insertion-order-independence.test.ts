import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Insertion-Order Independence Tests
 *
 * Inspired by OpenBGPD's test_evaluate() which tries all N!
 * insertion orderings to verify deterministic best-path selection.
 * Ensures computeRouteMetadata produces identical results
 * regardless of the order routes are added.
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

describe('Insertion-Order Independence', () => {
  it('2 peers: same best-path regardless of insertion order', () => {
    const routes = [
      { peer: PEER_B, nodePath: [PEER_B.name] },
      { peer: PEER_C, nodePath: [PEER_C.name, 'hop-2'] },
    ]

    const results: string[] = []
    for (const ordering of [routes, [...routes].reverse()]) {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      for (const r of ordering) {
        planCommit(rib, {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: r.peer,
            update: {
              updates: [
                {
                  action: 'add',
                  route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
                  nodePath: r.nodePath,
                },
              ],
            },
          },
        })
      }

      results.push(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName)
    }

    expect(results[0]).toBe(results[1])
    expect(results[0]).toBe(PEER_B.name)
  })

  it('3 peers: all 6 permutations produce same best-path', () => {
    const routes = [
      { peer: PEER_B, nodePath: [PEER_B.name] },
      { peer: PEER_C, nodePath: [PEER_C.name, 'hop-2'] },
      { peer: PEER_D, nodePath: [PEER_D.name, 'hop-2', 'hop-3'] },
    ]

    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]

    const results: string[] = []
    for (const perm of permutations) {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)
      connectPeer(rib, PEER_D)

      for (const idx of perm) {
        const r = routes[idx]
        planCommit(rib, {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: r.peer,
            update: {
              updates: [
                {
                  action: 'add',
                  route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
                  nodePath: r.nodePath,
                },
              ],
            },
          },
        })
      }

      results.push(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName)
    }

    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe(PEER_B.name)
  })
})
