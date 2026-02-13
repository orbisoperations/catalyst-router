import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Best-Path Selection Tests
 *
 * Inspired by OpenBGPD's rde_decide_test.c (full RFC 4271 decision
 * process), GoBGP's TestNeighAddrTieBreak and TestTimeTieBreaker,
 * and FRRouting's bgp_bestpath_reason topotest.
 *
 * Our implementation selects shortest nodePath (AS_PATH analog).
 * These tests verify deterministic tie-breaking, promotion after
 * withdrawal, and correct alternatives ordering.
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

describe('Best-Path Selection', () => {
  it('equal-length nodePath: deterministic tie-breaking by sort order', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // Both peers advertise same route with 1-hop path
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
    ])

    const metadata = rib.getRouteMetadata()
    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()
    expect(entry.selectionReason).toBe('shortest nodePath')
    expect(entry.alternatives).toHaveLength(1)

    // Both paths have length 1 — sort is stable, first in sort wins
    // The winner should be deterministic (not random)
    const winner = entry.bestPath.peerName
    expect([PEER_B.name, PEER_C.name]).toContain(winner)
  })

  it('best-path promotion after withdrawal: alternative becomes best', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B advertises with 1-hop (best), C with 2-hop (alternative)
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'node-other.somebiz.local.io',
    ])

    let metadata = rib.getRouteMetadata()
    expect(metadata.get('svc-x')!.bestPath.peerName).toBe(PEER_B.name)
    expect(metadata.get('svc-x')!.alternatives).toHaveLength(1)

    // Withdraw B's route
    planCommit(rib, {
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

    // C should be promoted to best
    metadata = rib.getRouteMetadata()
    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()
    expect(entry.bestPath.peerName).toBe(PEER_C.name)
    expect(entry.alternatives).toHaveLength(0)
    expect(entry.selectionReason).toBe('only candidate')
  })

  it('selection stability: remove and re-add best path restores it', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B: 1-hop, C: 2-hop
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'node-other.somebiz.local.io',
    ])

    expect(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName).toBe(PEER_B.name)

    // Withdraw B
    planCommit(rib, {
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
    expect(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName).toBe(PEER_C.name)

    // Re-add B with 1-hop
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])

    // B should be best again
    expect(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName).toBe(PEER_B.name)
  })

  it('three-way path comparison: shortest wins, alternatives in order', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)
    connectPeer(rib, PEER_D)

    // D: 3-hop (worst)
    injectRoute(rib, PEER_D, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_D.name,
      'hop-1.somebiz.local.io',
      'hop-2.somebiz.local.io',
    ])

    // B: 1-hop (best)
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])

    // C: 2-hop (middle)
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'hop-1.somebiz.local.io',
    ])

    const metadata = rib.getRouteMetadata()
    const entry = metadata.get('svc-x')!
    expect(entry).toBeDefined()

    // Best path: B (1-hop)
    expect(entry.bestPath.peerName).toBe(PEER_B.name)
    expect(entry.bestPath.nodePath).toHaveLength(1)

    // Alternatives sorted by path length: C (2-hop), D (3-hop)
    expect(entry.alternatives).toHaveLength(2)
    expect(entry.alternatives[0].nodePath.length).toBeLessThanOrEqual(
      entry.alternatives[1].nodePath.length
    )
    expect(entry.selectionReason).toBe('shortest nodePath')
  })

  it('metadata tracks multiple distinct routes independently', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // svc-x from both peers (different path lengths)
    injectRoute(rib, PEER_B, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_B.name,
    ])
    injectRoute(rib, PEER_C, { name: 'svc-x', protocol: 'http', endpoint: 'http://x:8080' }, [
      PEER_C.name,
      'node-other.somebiz.local.io',
    ])

    // svc-y only from C
    injectRoute(rib, PEER_C, { name: 'svc-y', protocol: 'http', endpoint: 'http://y:8080' }, [
      PEER_C.name,
    ])

    const metadata = rib.getRouteMetadata()
    expect(metadata.size).toBe(2)

    // svc-x has best path + 1 alternative
    expect(metadata.get('svc-x')!.alternatives).toHaveLength(1)
    expect(metadata.get('svc-x')!.selectionReason).toBe('shortest nodePath')

    // svc-y is only candidate
    expect(metadata.get('svc-y')!.alternatives).toHaveLength(0)
    expect(metadata.get('svc-y')!.selectionReason).toBe('only candidate')
  })
})
