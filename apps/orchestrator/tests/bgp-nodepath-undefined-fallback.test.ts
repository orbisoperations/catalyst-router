import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * nodePath Undefined Fallback Tests
 *
 * The RIB uses `nodePath ?? []` in both computeNewState and
 * computePropagations. These tests verify the fallback works
 * when nodePath is literally undefined (not just an empty array).
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

describe('nodePath Undefined Fallback', () => {
  it('undefined nodePath in update defaults to empty array in state', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_B,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
            } as any,
          ],
        },
      },
    })

    const routes = rib.getState().internal.routes
    expect(routes).toHaveLength(1)
    expect(routes[0].nodePath).toEqual([])
  })

  it('undefined nodePath in propagation filter does not crash', () => {
    const rib = createRib()
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
            } as any,
          ],
        },
      },
    })

    // Should propagate to C successfully with empty nodePath defaulted
    const toC = result.propagations.find((p) => p.type === 'update' && p.peer.name === PEER_C.name)
    expect(toC).toBeDefined()
    if (toC && toC.type === 'update') {
      // nodePath should be [NODE.name] (prepended by this node)
      expect(toC.update.updates[0].nodePath).toEqual([NODE.name])
    }
  })
})
