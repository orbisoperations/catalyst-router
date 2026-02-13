import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Withdrawal Ordering Tests
 *
 * Inspired by GoBGP's TestDestination_Calculate_ExplicitWithdraw /
 * TestDestination_Calculate_ImplicitWithdraw and FRRouting's
 * bgp_suppress_duplicates topotest.
 *
 * BGP UPDATE messages can contain interleaved add/remove actions.
 * These tests verify correct behavior for:
 * - Withdrawing nonexistent routes (idempotent)
 * - Double withdrawals
 * - Implicit withdrawal (same peer, same prefix, new attributes)
 * - Mixed add/remove in a single UpdateMessage
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

describe('Withdrawal Ordering', () => {
  it('withdraw of nonexistent route is a no-op (no crash, state unchanged)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    const stateBefore = rib.getState()
    expect(stateBefore.internal.routes).toHaveLength(0)

    // Remove a route that was never added
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'remove',
              route: { name: 'nonexistent', protocol: 'http' as const, endpoint: 'http://x:8080' },
            },
          ],
        },
      },
    })

    // State should be unchanged — no routes
    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('double withdraw is idempotent', () => {
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

    // First withdraw
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
    expect(rib.getState().internal.routes).toHaveLength(0)

    // Second withdraw — should be idempotent
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
    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('add after withdraw results in route present', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Add
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

    // Withdraw
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
    expect(rib.getState().internal.routes).toHaveLength(0)

    // Re-add
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
    expect(rib.getState().internal.routes[0].name).toBe('svc-x')
  })

  it('implicit withdrawal: second add from same peer replaces first (upsert)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // First add with endpoint A
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://old:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })
    expect(rib.getState().internal.routes).toHaveLength(1)
    expect(rib.getState().internal.routes[0].endpoint).toBe('http://old:8080')

    // Second add with different endpoint — implicit withdrawal of first
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://new:9090' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // Should have exactly 1 route with the new endpoint (not 2)
    expect(rib.getState().internal.routes).toHaveLength(1)
    expect(rib.getState().internal.routes[0].endpoint).toBe('http://new:9090')
  })

  it('mixed add/remove in single UpdateMessage: last action wins per route', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Single message: add svc-x, then remove svc-x
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
            {
              action: 'remove',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
            },
          ],
        },
      },
    })

    // Processing is sequential: add then remove → route absent
    expect(rib.getState().internal.routes).toHaveLength(0)
  })

  it('interleaved multi-route update: each route handled independently', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Pre-populate svc-b
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })
    expect(rib.getState().internal.routes).toHaveLength(1)

    // Single message: add A, remove B, add C
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
              nodePath: [PEER_B.name],
            },
            {
              action: 'remove',
              route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
            },
            {
              action: 'add',
              route: { name: 'svc-c', protocol: 'http' as const, endpoint: 'http://c:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    const routes = rib.getState().internal.routes
    expect(routes).toHaveLength(2)
    expect(routes.map((r) => r.name).sort()).toEqual(['svc-a', 'svc-c'])
  })
})
