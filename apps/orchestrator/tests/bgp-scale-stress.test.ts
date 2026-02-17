import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Scale / Stress Tests
 *
 * Validates RIB behavior under high route counts. Inspired by
 * GoBGP BenchmarkMultiPath, BIRD table GC tests, and FRR
 * bgp_batch_clearing (100K route operations).
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

describe('Scale / Stress', () => {
  it('100 local routes in single full sync propagation', () => {
    const rib = createRib()

    for (let i = 0; i < 100; i++) {
      planCommit(rib, {
        action: Actions.LocalRouteCreate,
        data: {
          name: `svc-${i.toString().padStart(3, '0')}`,
          protocol: 'http' as const,
          endpoint: `http://svc-${i}:8080`,
        },
      })
    }

    expect(rib.getState().local.routes).toHaveLength(100)

    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
    const result = planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_B },
    })

    const syncProp = result.propagations.find((p) => p.type === 'update')
    expect(syncProp).toBeDefined()
    if (syncProp && syncProp.type === 'update') {
      expect(syncProp.update.updates).toHaveLength(100)
    }
  })

  it('bulk add then bulk remove leaves clean state', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: Array.from({ length: 50 }, (_, i) => ({
            action: 'add' as const,
            route: {
              name: `svc-${i}`,
              protocol: 'http' as const,
              endpoint: `http://svc-${i}:8080`,
            },
            nodePath: [PEER_B.name],
          })),
        },
      },
    })
    expect(rib.getState().internal.routes).toHaveLength(50)

    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: Array.from({ length: 50 }, (_, i) => ({
            action: 'remove' as const,
            route: { name: `svc-${i}`, protocol: 'http' as const },
          })),
        },
      },
    })

    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(rib.getRouteMetadata().size).toBe(0)
  })

  it('routeMetadata map size matches unique route names after churn', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B: svc-0..svc-9, C: svc-5..svc-14 (5 overlap)
    for (let i = 0; i < 10; i++) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: `svc-${i}`,
                  protocol: 'http' as const,
                  endpoint: `http://b-${i}:8080`,
                },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })
    }
    for (let i = 5; i < 15; i++) {
      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_C,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: `svc-${i}`,
                  protocol: 'http' as const,
                  endpoint: `http://c-${i}:8080`,
                },
                nodePath: [PEER_C.name],
              },
            ],
          },
        },
      })
    }

    // 20 routes, 15 unique names
    expect(rib.getState().internal.routes).toHaveLength(20)
    expect(rib.getRouteMetadata().size).toBe(15)

    // Close B → 10 routes left, 10 unique names
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    expect(rib.getState().internal.routes).toHaveLength(10)
    expect(rib.getRouteMetadata().size).toBe(10)
  })
})
