import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Session Lifecycle Edge Case Tests
 *
 * Inspired by GoBGP's FSM tests (TestFSMHandler* family) and
 * FRRouting's bgp_peer_shut topotest (20-peer simultaneous shutdown).
 *
 * These tests verify correct behavior for non-happy-path session
 * transitions: double opens, close on unknown peers, deletion
 * before connection, and reconnection after close.
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

describe('Session Lifecycle Edge Cases', () => {
  it('double InternalProtocolOpen on connected peer is idempotent', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    const peerBefore = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)!
    expect(peerBefore.connectionStatus).toBe('connected')

    // Open again — should stay connected
    planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: PEER_B } })

    const peerAfter = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)!
    expect(peerAfter.connectionStatus).toBe('connected')
    // Peer should still exist exactly once
    expect(rib.getState().internal.peers.filter((p) => p.name === PEER_B.name)).toHaveLength(1)
  })

  it('InternalProtocolClose on unknown peer is a no-op', () => {
    const rib = createRib()

    const stateBefore = rib.getState()

    // Close a peer that doesn't exist — should not crash
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })

    // State unchanged
    expect(rib.getState().internal.peers).toHaveLength(stateBefore.internal.peers.length)
  })

  it('LocalPeerDelete on initializing peer (never opened) succeeds', () => {
    const rib = createRib()

    // Create but don't open
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
    expect(rib.getState().internal.peers).toHaveLength(1)
    expect(rib.getState().internal.peers[0].connectionStatus).toBe('initializing')

    // Delete the initializing peer
    planCommit(rib, { action: Actions.LocalPeerDelete, data: { name: PEER_B.name } })
    expect(rib.getState().internal.peers).toHaveLength(0)
  })

  it('LocalPeerUpdate resets connectionStatus to initializing', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    expect(rib.getState().internal.peers[0].connectionStatus).toBe('connected')

    // Update the peer — should reset to initializing
    planCommit(rib, {
      action: Actions.LocalPeerUpdate,
      data: { ...PEER_B, endpoint: 'http://node-b:4000' },
    })

    const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)!
    expect(peer.connectionStatus).toBe('initializing')
    expect(peer.endpoint).toBe('http://node-b:4000')
  })

  it('multi-peer disconnect cleanup: all routes from all closed peers removed', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)
    connectPeer(rib, PEER_D)

    // Each peer advertises a route
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
                  name: `svc-from-${peer.name.split('.')[0]}`,
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
    expect(rib.getState().internal.routes).toHaveLength(3)

    // Close all three
    for (const peer of [PEER_B, PEER_C, PEER_D]) {
      planCommit(rib, {
        action: Actions.InternalProtocolClose,
        data: { peerInfo: peer, code: 1000 },
      })
    }

    // Zero routes, zero peers — no zombies
    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(rib.getState().internal.peers).toHaveLength(0)
  })

  it('reconnect after close: fresh session with no stale routes', () => {
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
    expect(rib.getState().internal.routes).toHaveLength(1)

    // Close
    planCommit(rib, {
      action: Actions.InternalProtocolClose,
      data: { peerInfo: PEER_B, code: 1000 },
    })
    expect(rib.getState().internal.routes).toHaveLength(0)
    expect(rib.getState().internal.peers).toHaveLength(0)

    // Reconnect: create + open
    connectPeer(rib, PEER_B)

    // Session is fresh — no stale routes
    expect(rib.getState().internal.peers).toHaveLength(1)
    expect(rib.getState().internal.peers[0].connectionStatus).toBe('connected')
    expect(rib.getState().internal.routes).toHaveLength(0)
  })
})
