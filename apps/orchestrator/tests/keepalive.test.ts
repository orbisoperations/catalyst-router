import { describe, it, expect } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { RoutingInformationBase, type Plan } from '../src/rib.js'
import type { OrchestratorConfig } from '../src/types.js'

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

function createRib(config: OrchestratorConfig = CONFIG) {
  return new RoutingInformationBase(config)
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
  // Access internal state to set timing fields for testing.
  // This avoids needing to mock Date.now() or wait real time.
  const state = rib.getState()
  const updatedPeers = state.internal.peers.map((p) =>
    p.name === peerName ? { ...p, ...fields } : p
  )
  // Use plan/commit with a no-op to inject state would be complex,
  // so we reach into the RIB via a Tick that doesn't expire anything
  // and manually set the peer fields by using the state object directly.
  // The RIB state is mutable via commit, so we construct a synthetic plan.
  const newState = {
    ...state,
    internal: { ...state.internal, peers: updatedPeers },
  }
  // Commit a synthetic plan to update the state
  rib.commit({
    success: true,
    action: { action: Actions.Tick, data: { now: 0 } },
    prevState: state,
    newState,
    propagations: [],
  })
}

describe('Keepalive Tick Mechanism', () => {
  describe('hold timer expiry', () => {
    it('expires peer when now > lastReceived + holdTime', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // Set holdTime=60s, lastReceived=1000
      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 1000,
        lastSent: 1000,
      })

      // Tick at t=62000 (62s after lastReceived, exceeds 60s holdTime)
      const plan = rib.plan({ action: Actions.Tick, data: { now: 62_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      // Expired peer should be removed from newState
      expect(p.newState.internal.peers).toHaveLength(0)
    })

    it('does not expire peer when within holdTime', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 1000,
        lastSent: 1000,
      })

      // Tick at t=50000 (50s after lastReceived, within 60s holdTime)
      const plan = rib.plan({ action: Actions.Tick, data: { now: 50_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      expect(p.newState.internal.peers).toHaveLength(1)
    })

    it('expired peer routes are withdrawn', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // Add a route from peer B
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

      expect(rib.getState().internal.routes).toHaveLength(1)

      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 1000,
        lastSent: 1000,
      })

      const plan = rib.plan({ action: Actions.Tick, data: { now: 62_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      expect(p.newState.internal.routes).toHaveLength(0)
    })

    it('expired peer routes are propagated as withdrawals to remaining peers', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // Add a route from peer B
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

      // Expire B only (C stays healthy)
      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 1000,
        lastSent: 1000,
      })

      const plan = rib.plan({ action: Actions.Tick, data: { now: 62_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      // Should propagate withdrawal to C
      const updateProps = p.propagations.filter((pr) => pr.type === 'update')
      expect(updateProps).toHaveLength(1)
      expect(updateProps[0].peer.name).toBe(PEER_C.name)
    })
  })

  describe('keepalive sending', () => {
    it('sends keepalive when now > lastSent + keepaliveInterval', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // holdTime=60, keepaliveInterval = 60/3 = 20s
      // lastSent=1000, tick at 22000 (22s later, exceeds 20s interval)
      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 20_000,
        lastSent: 1000,
      })

      const plan = rib.plan({ action: Actions.Tick, data: { now: 22_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      const keepalives = p.propagations.filter((pr) => pr.type === 'keepalive')
      expect(keepalives).toHaveLength(1)
      expect(keepalives[0].peer.name).toBe(PEER_B.name)
    })

    it('does not send keepalive when within keepalive interval', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // holdTime=60, keepaliveInterval = 20s
      // lastSent=1000, tick at 15000 (15s later, within 20s interval)
      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 15_000,
        lastSent: 1000,
      })

      const plan = rib.plan({ action: Actions.Tick, data: { now: 15_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      const keepalives = p.propagations.filter((pr) => pr.type === 'keepalive')
      expect(keepalives).toHaveLength(0)
    })
  })

  describe('backward compatibility', () => {
    it('tick is no-op when no peers have holdTime', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      // No holdTime set — peer should not be expired or keepalived
      const plan = rib.plan({ action: Actions.Tick, data: { now: 999_999_999 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      expect(p.newState.internal.peers).toHaveLength(1)
      expect(p.propagations).toHaveLength(0)
    })

    it('tick is no-op with empty peer list', () => {
      const rib = createRib()

      const plan = rib.plan({ action: Actions.Tick, data: { now: Date.now() } })
      expect(plan.success).toBe(true)

      const p = plan as Plan
      expect(p.propagations).toHaveLength(0)
    })
  })

  describe('ordering', () => {
    it('expirations are processed before keepalives (no keepalive to dead peer)', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)
      connectPeer(rib, PEER_C)

      // B is expired (holdTime=60, lastReceived 70s ago)
      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: 1000,
        lastSent: 1000,
      })

      // C needs keepalive (holdTime=60, lastSent 25s ago, within hold but past keepalive interval)
      setPeerTimingFields(rib, PEER_C.name, {
        holdTime: 60,
        lastReceived: 70_000,
        lastSent: 46_000,
      })

      const plan = rib.plan({ action: Actions.Tick, data: { now: 71_000 } })
      expect(plan.success).toBe(true)

      const p = plan as Plan

      // B should be expired (removed from state)
      expect(p.newState.internal.peers.find((pr) => pr.name === PEER_B.name)).toBeUndefined()

      // No keepalive to B (it's dead)
      const keepalives = p.propagations.filter((pr) => pr.type === 'keepalive')
      for (const ka of keepalives) {
        expect(ka.peer.name).not.toBe(PEER_B.name)
      }

      // C gets a keepalive
      expect(keepalives.some((ka) => ka.peer.name === PEER_C.name)).toBe(true)
    })
  })

  describe('lastReceived updates', () => {
    it('InternalProtocolOpen updates lastReceived', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

      planCommit(rib, { action: Actions.InternalProtocolOpen, data: { peerInfo: PEER_B } })

      const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
      expect(peer?.lastReceived).toBeDefined()
      expect(peer!.lastReceived!).toBeGreaterThan(0)
    })

    it('InternalProtocolConnected updates lastReceived', () => {
      const rib = createRib()
      planCommit(rib, { action: Actions.LocalPeerCreate, data: PEER_B })

      planCommit(rib, { action: Actions.InternalProtocolConnected, data: { peerInfo: PEER_B } })

      const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
      expect(peer?.lastReceived).toBeDefined()
      expect(peer!.lastReceived!).toBeGreaterThan(0)
    })

    it('InternalProtocolUpdate updates lastReceived', () => {
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
                route: { name: 'svc-b', protocol: 'http' as const, endpoint: 'http://b:8080' },
                nodePath: [PEER_B.name],
              },
            ],
          },
        },
      })

      const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
      expect(peer?.lastReceived).toBeDefined()
      expect(peer!.lastReceived!).toBeGreaterThan(0)
    })
  })

  describe('lastSent updates via commit', () => {
    it('commit updates lastSent for peers receiving propagations', () => {
      const rib = createRib()
      connectPeer(rib, PEER_B)

      setPeerTimingFields(rib, PEER_B.name, {
        holdTime: 60,
        lastReceived: Date.now(),
        lastSent: 0,
      })

      // Adding a local route should propagate to B
      const plan = rib.plan({
        action: Actions.LocalRouteCreate,
        data: { name: 'svc-a', protocol: 'http' as const, endpoint: 'http://a:8080' },
      })
      expect(plan.success).toBe(true)

      const result = rib.commit(plan as Plan)
      expect(result.propagations).toHaveLength(1)

      const peer = rib.getState().internal.peers.find((p) => p.name === PEER_B.name)
      expect(peer?.lastSent).toBeDefined()
      expect(peer!.lastSent!).toBeGreaterThan(0)
    })
  })
})
