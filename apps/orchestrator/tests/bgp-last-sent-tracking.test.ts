import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * lastSent Tracking Tests
 *
 * commit() updates lastSent only for peers that receive 'update'
 * or 'keepalive' propagations — NOT for 'open' or 'close' types.
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

describe('lastSent Tracking', () => {
  it('not updated for open propagation', () => {
    const rib = createRib()

    const result = planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    expect(result.propagations).toHaveLength(1)
    expect(result.propagations[0].type).toBe('open')

    const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
    expect(peer).toBeDefined()
    expect(peer!.lastSent).toBeUndefined()
  })

  it('updated for update propagation', () => {
    const rib = createRib()

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })

    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })
    planCommit(rib, {
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_B },
    })

    // lastSent should be set after the open (which triggers a full sync update)
    const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
    expect(peer).toBeDefined()
    expect(peer!.lastSent).toBeNumber()
  })
})
