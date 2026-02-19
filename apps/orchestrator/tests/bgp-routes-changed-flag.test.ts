import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * routesChanged Flag Tests
 *
 * The commit() result includes a routesChanged boolean that indicates
 * whether local or internal routes changed. This is used by the
 * orchestrator to decide if envoy config needs updating.
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

describe('routesChanged Flag', () => {
  it('true when internal routes change via InternalProtocolUpdate', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    const plan = rib.plan({
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
    expect(plan.success).toBe(true)
    const result = rib.commit(plan as Plan)
    expect(result.routesChanged).toBe(true)
  })

  it('true when local routes change via LocalRouteCreate', () => {
    const rib = createRib()

    const plan = rib.plan({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })
    expect(plan.success).toBe(true)
    const result = rib.commit(plan as Plan)
    expect(result.routesChanged).toBe(true)
  })

  it('false for peer-only state changes', () => {
    const rib = createRib()

    const plan = rib.plan({ action: Actions.LocalPeerCreate, data: PEER_B })
    expect(plan.success).toBe(true)
    const result = rib.commit(plan as Plan)
    expect(result.routesChanged).toBe(false)
  })

  it('false for InternalProtocolOpen (only peer status changes)', () => {
    const rib = createRib()
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const plan = rib.plan({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: PEER_B },
    })
    expect(plan.success).toBe(true)
    const result = rib.commit(plan as Plan)
    expect(result.routesChanged).toBe(false)
  })
})
