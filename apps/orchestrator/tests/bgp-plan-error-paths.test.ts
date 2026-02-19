import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Plan Error Path Tests
 *
 * Every plan() call that returns { success: false } — validates
 * that all error guard branches are exercised.
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

describe('Plan Error Paths', () => {
  it('LocalPeerUpdate for nonexistent peer returns failure', () => {
    const rib = createRib()
    const result = rib.plan({
      action: Actions.LocalPeerUpdate,
      data: {
        name: 'nonexistent-peer',
        endpoint: 'http://x:3000',
        domains: ['x.local.io'],
        peerToken: 'token',
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Peer not found')
    }
  })

  it('LocalPeerDelete for nonexistent peer returns failure', () => {
    const rib = createRib()
    const result = rib.plan({
      action: Actions.LocalPeerDelete,
      data: { name: 'nonexistent-peer' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Peer not found')
    }
  })

  it('LocalRouteDelete for nonexistent route returns failure', () => {
    const rib = createRib()
    const result = rib.plan({
      action: Actions.LocalRouteDelete,
      data: { name: 'nonexistent-route', protocol: 'http' as const },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Route not found')
    }
  })

  it('LocalPeerCreate without peerToken returns failure', () => {
    const rib = createRib()
    const result = rib.plan({
      action: Actions.LocalPeerCreate,
      data: {
        name: 'peer-no-token',
        endpoint: 'http://x:3000',
        domains: ['x.local.io'],
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('peerToken is required when creating a peer')
    }
  })

  it('LocalPeerCreate for existing peer returns failure', () => {
    const rib = createRib()
    planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

    const result = rib.plan({ action: Actions.LocalPeerCreate, data: PEER_B })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Peer already exists')
    }
  })

  it('LocalRouteCreate for existing route returns failure', () => {
    const rib = createRib()
    planCommit(rib, {
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:8080' },
    })

    const result = rib.plan({
      action: Actions.LocalRouteCreate,
      data: { name: 'svc-x', protocol: 'http' as const, endpoint: 'http://x:9090' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Route already exists')
    }
  })
})
