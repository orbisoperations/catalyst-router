import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * InternalProtocolConnected Tests
 *
 * The Connected action is the outbound connection path (vs Open for inbound).
 * Tests cover full sync propagation, unknown peer no-op, empty RIB sync,
 * and the missing peerToken guard.
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

describe('InternalProtocolConnected', () => {
  it('unknown peer is a silent no-op', () => {
    const rib = createRib()

    const result = planCommit(rib, {
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: PEER_B },
    })

    expect(rib.getState().internal.peers).toHaveLength(0)
    expect(result.propagations).toHaveLength(0)
  })

  it('produces full sync propagation when routes exist', () => {
    const rib = createRib()

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })

    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const result = planCommit(rib, {
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: PEER_B },
    })

    expect(result.propagations).toHaveLength(1)
    expect(result.propagations[0].type).toBe('update')
    if (result.propagations[0].type === 'update') {
      expect(result.propagations[0].update.updates).toHaveLength(1)
      expect(result.propagations[0].update.updates[0].route.name).toBe('svc-x')
    }
  })

  it('empty RIB produces zero propagations', () => {
    const rib = createRib()
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const result = planCommit(rib, {
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: PEER_B },
    })

    expect(result.propagations).toHaveLength(0)
  })

  it('missing peerToken produces zero propagations', () => {
    const rib = createRib()

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })

    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const peerWithoutToken: PeerInfo = {
      name: PEER_B.name,
      endpoint: PEER_B.endpoint,
      domains: PEER_B.domains,
    }
    const result = planCommit(rib, {
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerWithoutToken },
    })

    expect(result.propagations).toHaveLength(0)
  })
})
