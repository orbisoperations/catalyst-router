import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Upsert Propagation Tests
 *
 * When a peer sends an 'add' for an existing route (implicit withdrawal),
 * the downstream propagation semantics and best-path recalculation.
 * Inspired by GoBGP TestDestination_Calculate_ImplicitWithdraw and
 * TestRTCWithdrawUpdatedPath.
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

describe('Upsert Propagation', () => {
  it('sends single add (not remove+add) to downstream on upsert', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

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

    // B upserts with new endpoint
    const result = planCommit(rib, {
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

    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      expect(toC.update.updates).toHaveLength(1)
      expect(toC.update.updates[0].action).toBe('add')
      expect(toC.update.updates[0].route.endpoint).toBe('http://new:9090')
    }
  })

  it('implicit withdrawal with longer nodePath recalculates best-path', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // B: 1-hop (best)
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://b:8080' },
              nodePath: [PEER_B.name],
            },
          ],
        },
      },
    })

    // C: 2-hop (alternative)
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_C,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://c:8080' },
              nodePath: [PEER_C.name, 'other-node'],
            },
          ],
        },
      },
    })

    expect(rib.getRouteMetadata().get('svc-x')!.bestPath.peerName).toBe(PEER_B.name)

    // B upserts with 3-hop path
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://b:8080' },
              nodePath: [PEER_B.name, 'hop-1', 'hop-2'],
            },
          ],
        },
      },
    })

    // C should now be best (2-hop < 3-hop)
    const meta = rib.getRouteMetadata().get('svc-x')
    expect(meta!.bestPath.peerName).toBe(PEER_C.name)
    expect(meta!.selectionReason).toBe('shortest nodePath')
  })
})
