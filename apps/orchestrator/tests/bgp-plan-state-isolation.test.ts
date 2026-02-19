import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Plan State Isolation Tests
 *
 * Verifies that plan() produces isolated state objects — mutating
 * one plan's output does not affect another. Inspired by GoBGP's
 * immutable state design and the JavaScript shallow-copy footgun.
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

describe('Plan State Isolation', () => {
  it('two plans from same state have independent route lists', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    const planA = rib.plan({
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
          ],
        },
      },
    }) as Plan

    const planB = rib.plan({
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
    }) as Plan

    const aNames = planA.newState.internal.routes.map((r) => r.name)
    const bNames = planB.newState.internal.routes.map((r) => r.name)

    expect(aNames).toContain('svc-a')
    expect(aNames).not.toContain('svc-b')
    expect(bNames).toContain('svc-b')
    expect(bNames).not.toContain('svc-a')
  })

  it('committing plan A does not corrupt plan B', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    const planA = rib.plan({
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
          ],
        },
      },
    }) as Plan

    const planB = rib.plan({
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
    }) as Plan

    rib.commit(planA)

    // Plan B should still only have svc-b
    const bNames = planB.newState.internal.routes.map((r) => r.name)
    expect(bNames).toContain('svc-b')
    expect(bNames).not.toContain('svc-a')
  })
})
