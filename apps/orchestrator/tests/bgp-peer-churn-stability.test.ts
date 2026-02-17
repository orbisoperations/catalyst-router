import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import { createPortAllocator } from '@catalyst/envoy-service'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Peer Churn Stability Tests
 *
 * Verifies that repeated peer connect/disconnect cycles do not
 * accumulate state or leak port allocator resources. Inspired by
 * GoBGP's TestNumGoroutineWithAddDeleteNeighbor.
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

function planCommit(rib: RoutingInformationBase, action: Parameters<typeof rib.plan>[0]) {
  const plan = rib.plan(action)
  if (!plan.success) throw new Error(`plan failed: ${plan.error}`)
  return rib.commit(plan)
}

function connectPeer(rib: RoutingInformationBase, peer: PeerInfo) {
  planCommit(rib, { action: Actions.LocalPeerCreate, data: peer })
  planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: peer } })
}

describe('Peer Churn Stability', () => {
  it('100 connect/route/close cycles leave zero state', () => {
    const config: OrchestratorConfig = { node: NODE }
    const rib = new RoutingInformationBase(config)

    for (let i = 0; i < 100; i++) {
      connectPeer(rib, PEER_B)

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
                  endpoint: 'http://svc:8080',
                },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      planCommit(rib, {
        action: Actions.InternalProtocolClose,
        data: { peerInfo: PEER_B, code: 1000 },
      })
    }

    expect(rib.getState().internal.peers).toHaveLength(0)
    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(rib.getRouteMetadata().size).toBe(0)
  })

  it('port allocator churn: 20 cycles release all ports', () => {
    const config: OrchestratorConfig = {
      node: NODE,
      envoyConfig: {
        endpoint: 'http://envoy:18000',
        portRange: [[10000, 10100]],
      },
    }
    const allocator = createPortAllocator([[10000, 10100]])
    const rib = new RoutingInformationBase(config, allocator)

    const initialAvailable = allocator.availableCount()

    for (let i = 0; i < 20; i++) {
      connectPeer(rib, PEER_B)

      planCommit(rib, {
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: PEER_B,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'svc-x',
                  protocol: 'http' as const,
                  endpoint: 'http://x:8080',
                },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      planCommit(rib, {
        action: Actions.InternalProtocolClose,
        data: { peerInfo: PEER_B, code: 1000 },
      })
    }

    expect(rib.getState().internal.peers).toHaveLength(0)
    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(allocator.availableCount()).toBe(initialAvailable)
  })
})
