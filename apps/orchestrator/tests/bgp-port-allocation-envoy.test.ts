import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import { createPortAllocator } from '@catalyst/envoy-service'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Port Allocation + Envoy Tests (RIB-level)
 *
 * These tests exercise the RIB's port allocation logic directly,
 * without the full orchestrator/transport layer. They verify that
 * computePortOps, stampPortsOnState, and egress port handling
 * work correctly at the RIB level.
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

function createRibWithEnvoy() {
  const config: OrchestratorConfig = {
    node: NODE,
    envoyConfig: {
      endpoint: 'http://envoy:18000',
      portRange: [[10000, 10100]],
    },
  }
  const allocator = createPortAllocator([[10000, 10100]])
  return { rib: new RoutingInformationBase(config, allocator), allocator }
}

function createRibWithoutEnvoy() {
  const config: OrchestratorConfig = { node: NODE }
  return new RoutingInformationBase(config)
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

describe('Port Allocation + Envoy (RIB-level)', () => {
  it('egress port allocated on internal route from peer', () => {
    const { rib, allocator } = createRibWithEnvoy()
    connectPeer(rib, PEER_B)

    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'movies-api', protocol: 'http' as const, endpoint: 'http://m:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Egress port should be allocated
    const egressKey = `egress_movies-api_via_${PEER_B.name}`
    const port = allocator.getPort(egressKey)
    expect(port).toBeDefined()
    expect(port).toBeGreaterThanOrEqual(10000)
    expect(port).toBeLessThanOrEqual(10100)
  })

  it('multi-hop propagation uses local egress port (not remote port)', () => {
    const { rib } = createRibWithEnvoy()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B sends a route with B's envoyPort=5000
    const result = planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http' as const,
                endpoint: 'http://books:8080',
                envoyPort: 5000,
              },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Propagation to C should use local egress port, NOT 5000
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      const addUpdate = toC.update.updates.find((u) => u.action === 'add')
      expect(addUpdate).toBeDefined()
      expect(addUpdate!.route.envoyPort).toBeNumber()
      expect(addUpdate!.route.envoyPort).toBeGreaterThanOrEqual(10000)
      expect(addUpdate!.route.envoyPort).not.toBe(5000)
    }
  })

  it('full sync on peer connect uses stamped egress ports', () => {
    const { rib } = createRibWithEnvoy()
    connectPeer(rib, PEER_B)

    // Receive route from B with B's port
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http' as const,
                endpoint: 'http://books:8080',
                envoyPort: 5000,
              },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Now connect C — full sync should use local egress port
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_C })
    const openResult = planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_C },
    })

    const syncProp = openResult.propagations.find((p) => p.type === 'update')
    expect(syncProp).toBeDefined()
    if (syncProp && syncProp.type === 'update') {
      const booksUpdate = syncProp.update.updates.find(
        (u) => u.action === 'add' && u.route.name === 'books-api'
      )
      expect(booksUpdate).toBeDefined()
      // Should be the local egress port, not B's port
      expect(booksUpdate!.route.envoyPort).toBeGreaterThanOrEqual(10000)
      expect(booksUpdate!.route.envoyPort).not.toBe(5000)
    }
  })

  it('no envoyPort without envoyConfig (no port allocator)', () => {
    const rib = createRibWithoutEnvoy()
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

    // portOperations should be empty
    expect(result.portOperations).toHaveLength(0)

    // Propagation to C should NOT have envoyPort set
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      const addUpdate = toC.update.updates.find((u) => u.action === 'add')
      expect(addUpdate!.route.envoyPort).toBeUndefined()
    }
  })

  it('stampPortsOnState preserves pre-existing envoyPort', () => {
    const { rib } = createRibWithEnvoy()
    connectPeer(rib, PEER_B)

    // B sends a route that already has envoyPort=5000 (B's local port)
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http' as const,
                endpoint: 'http://books:8080',
                envoyPort: 5000,
              },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // The internal route in state should still have the egress port stamped
    // by the allocator (not the original 5000), because stampPortsOnState
    // checks !r.envoyPort. Since the route arrives WITH envoyPort=5000,
    // the stamp is skipped and the route keeps 5000.
    const route = rib.getState().internal.routes.find((r) => r.name === 'books-api')
    expect(route).toBeDefined()
    expect(route!.envoyPort).toBe(5000)
  })

  it('InternalProtocolClose releases egress ports', () => {
    const { rib, allocator } = createRibWithEnvoy()
    connectPeer(rib, PEER_B)

    // Receive 2 routes from B
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

    // Both egress ports should be allocated
    expect(allocator.getPort(`egress_svc-1_via_${PEER_B.name}`)).toBeDefined()
    expect(allocator.getPort(`egress_svc-2_via_${PEER_B.name}`)).toBeDefined()

    const availableBefore = allocator.availableCount()

    // Close the peer
    const result = planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    // Ports should be released
    expect(allocator.getPort(`egress_svc-1_via_${PEER_B.name}`)).toBeUndefined()
    expect(allocator.getPort(`egress_svc-2_via_${PEER_B.name}`)).toBeUndefined()

    // Available count should have increased by 2
    expect(allocator.availableCount()).toBe(availableBefore + 2)

    // portOperations should include the releases
    const releases = result.portOperations.filter((op) => op.type === 'release')
    expect(releases).toHaveLength(2)
  })
})
