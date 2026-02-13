import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

/**
 * Hold Timer Edge Case Tests
 *
 * Inspired by GoBGP's TestFSMHandlerOpenconfirm_HoldtimeZero (holdTime=0
 * means "never expire") and FRRouting's bgp_minimum_holdtime topotest.
 *
 * These tests exercise boundary conditions in the hold-timer and
 * keepalive-interval logic that are not covered by the main
 * keepalive.test.ts suite.
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

function setPeerTimingFields(
  rib: RoutingInformationBase,
  peerName: string,
  fields: { lastReceived?: number; lastSent?: number; holdTime?: number }
) {
  const state = rib.getState()
  const updatedPeers = state.internal.peers.map((p) =>
    p.name === peerName ? { ...p, ...fields } : p
  )
  const newState = {
    ...state,
    internal: { ...state.internal, peers: updatedPeers },
  }
  rib.commit({
    success: true,
    action: { action: Actions.Tick, data: { now: 0 } },
    prevState: state,
    newState,
    portOperations: [],
    routeMetadata: new Map(),
  })
}

describe('Hold Timer Edge Cases', () => {
  it('holdTime=0 causes immediate expiry (any elapsed time > 0ms triggers)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // holdTime=0 → holdTime * 1000 = 0 → any elapsed time > 0 triggers expiry.
    // (Note: RFC 4271 treats holdTime=0 as "infinite", but our impl treats
    // it as an immediate expiry threshold. Documented here for awareness.)
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 0,
      lastReceived: 1000,
      lastSent: 1000,
    })

    // Even 1ms elapsed → expired
    const plan = rib.plan({ action: Actions.Tick, data: { now: 1001 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    expect(p.newState.internal.peers).toHaveLength(0)
  })

  it('holdTime undefined means no expiry (backward compat)', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Default peer has no holdTime — should never expire
    const plan = rib.plan({ action: Actions.Tick, data: { now: 999_999_999 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    expect(p.newState.internal.peers).toHaveLength(1)
  })

  it('boundary: exactly at holdTime threshold is NOT expired', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // holdTime=60, lastReceived=1000
    // Expiry check: now - lastReceived > holdTime * 1000
    // At exactly 61000: 61000 - 1000 = 60000, NOT > 60000 → not expired
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })

    const plan = rib.plan({ action: Actions.Tick, data: { now: 61_000 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    expect(p.newState.internal.peers).toHaveLength(1)
  })

  it('boundary: 1ms past holdTime IS expired', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // holdTime=60, lastReceived=1000
    // At 61001: 61001 - 1000 = 60001 > 60000 → expired
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })

    const plan = rib.plan({ action: Actions.Tick, data: { now: 61_001 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    expect(p.newState.internal.peers).toHaveLength(0)
  })

  it('keepalive boundary: exactly at holdTime/3 is NOT sent', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // holdTime=60, keepalive interval = 20s
    // Keepalive check: now - lastSent > (holdTime / 3) * 1000
    // At exactly 21000: 21000 - 1000 = 20000, NOT > 20000 → no keepalive
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 21_000,
      lastSent: 1000,
    })

    const plan = rib.plan({ action: Actions.Tick, data: { now: 21_000 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    const result = rib.commit(p)
    const keepalives = result.propagations.filter((pr) => pr.type === 'keepalive')
    expect(keepalives).toHaveLength(0)
  })

  it('lastSent undefined means no keepalive sent', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)

    // Peer has holdTime but no lastSent — keepalive condition won't fire
    // because the check requires lastSent != null
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 50_000,
      // lastSent intentionally omitted
    })

    const plan = rib.plan({ action: Actions.Tick, data: { now: 50_000 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    const result = rib.commit(p)
    const keepalives = result.propagations.filter((pr) => pr.type === 'keepalive')
    expect(keepalives).toHaveLength(0)
  })

  it('multiple peers expire on the same tick', () => {
    const rib = createRib()
    connectPeer(rib, PEER_B)
    connectPeer(rib, PEER_C)

    // Both peers have holdTime=60, lastReceived=1000
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })
    setPeerTimingFields(rib, PEER_C.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })

    // Add routes from both
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
    planCommit(rib, {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: PEER_C,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-c', protocol: 'http' as const, endpoint: 'http://c:8080' },
              nodePath: [PEER_C.name],
            },
          ],
        },
      },
    })

    // Re-set timing after route updates (since InternalProtocolUpdate updates lastReceived)
    setPeerTimingFields(rib, PEER_B.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })
    setPeerTimingFields(rib, PEER_C.name, {
      holdTime: 60,
      lastReceived: 1000,
      lastSent: 1000,
    })

    expect(rib.getState().internal.routes).toHaveLength(2)

    // Tick past both hold timers
    const plan = rib.plan({ action: Actions.Tick, data: { now: 62_000 } })
    expect(plan.success).toBe(true)

    const p = plan as Plan
    // Both peers and all routes removed
    expect(p.newState.internal.peers).toHaveLength(0)
    expect(p.newState.internal.routes).toHaveLength(0)
  })
})
