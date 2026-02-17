import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Local Route Preference Tests
 *
 * Verifies that local and internal routes with the same name coexist
 * independently. Inspired by BIRD's DEF_PREF_DIRECT > DEF_PREF_BGP
 * hierarchy. Documents current behavior where local/internal are
 * separate namespaces (no cross-preference).
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

describe('Local Route Preference', () => {
  it('local and internal routes with same name coexist', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

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

    expect(rib.getState().local.routes.find((r) => r.name === 'svc-x')).toBeDefined()
    expect(rib.getState().internal.routes.find((r) => r.name === 'svc-x')).toBeDefined()
  })

  it('deleting local route does not remove internal route with same name', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://local:8080' },
    })

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

    planCommit(rib, {
      action: Actions.LocalRouteDelete,
      data: { name: 'svc-x', protocol: 'http' as const },
    })

    expect(rib.getState().local.routes.find((r) => r.name === 'svc-x')).toBeUndefined()
    expect(rib.getState().internal.routes.find((r) => r.name === 'svc-x')).toBeDefined()
  })
})
