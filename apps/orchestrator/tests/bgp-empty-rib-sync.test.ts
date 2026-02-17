import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Empty RIB Sync Tests
 *
 * Verifies that InternalProtocolOpen produces zero propagations
 * when there are no routes to sync (the early-return path at
 * rib.ts computePropagations for InternalProtocolOpen).
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

describe('Empty RIB Sync', () => {
  it('InternalProtocolOpen with empty RIB produces zero propagations', () => {
    const rib = createRib()
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const result = planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_B },
    })

    expect(result.propagations).toHaveLength(0)
  })

  it('InternalProtocolOpen with routes produces sync propagation', () => {
    const rib = createRib()

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })

    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
    const result = planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_B },
    })

    expect(result.propagations).toHaveLength(1)
    if (result.propagations[0].type === 'update') {
      expect(result.propagations[0].peer.peerToken).toBe('token-for-b')
    }
  })
})
