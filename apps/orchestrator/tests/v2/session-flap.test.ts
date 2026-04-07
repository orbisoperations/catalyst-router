import { describe, it, expect } from 'vitest'
import {
  RoutingInformationBase,
  Actions,
  CloseCodes,
  SESSION_FLAP_BASE_DELAY_MS,
  SESSION_FLAP_MAX_DELAY_MS,
  SESSION_FLAP_STABILITY_MS,
} from '@catalyst/routing/v2'
import type { PeerInfo, Action } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }

/** Deterministic base timestamp for all tests. */
const T0 = 1_000_000

/** Add peer via LocalPeerCreate, then connect via InternalProtocolConnected */
function createAndConnectPeer(rib: RoutingInformationBase, now: number): void {
  const create: Action = {
    action: Actions.LocalPeerCreate,
    data: peerB,
  }
  const p1 = rib.plan(create, rib.state, now)
  rib.commit(p1, create)

  const connect: Action = {
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerB },
  }
  const p2 = rib.plan(connect, rib.state, now)
  rib.commit(p2, connect)
}

/** Disconnect peer via InternalProtocolClose with transport error */
function disconnectPeer(rib: RoutingInformationBase, now: number): void {
  const close: Action = {
    action: Actions.InternalProtocolClose,
    data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR, reason: 'disconnect' },
  }
  const plan = rib.plan(close, rib.state, now)
  rib.commit(plan, close)
}

/** Reconnect peer via InternalProtocolConnected */
function reconnectPeer(rib: RoutingInformationBase, now: number): void {
  const connect: Action = {
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerB },
  }
  const plan = rib.plan(connect, rib.state, now)
  rib.commit(plan, connect)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session flap detection (RFC 4271 §8 / BIRD error-wait)', () => {
  it('first disconnect sets consecutiveFailures to 1', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib, T0)

    // Verify connected and zero failures
    const peerBefore = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerBefore.connectionStatus).toBe('connected')
    expect(peerBefore.consecutiveFailures).toBe(0)

    // Disconnect
    disconnectPeer(rib, T0 + 1000)

    const peerAfter = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerAfter.connectionStatus).toBe('closed')
    expect(peerAfter.consecutiveFailures).toBe(1)
    expect(peerAfter.lastFailure).toBe(T0 + 1000)
  })

  it('third consecutive reconnect has sync deferred with expected delay', () => {
    const rib = new RoutingInformationBase({ nodeId })
    let now = T0
    createAndConnectPeer(rib, now)

    // 3 close/connect cycles
    for (let i = 0; i < 3; i++) {
      now += 1000
      disconnectPeer(rib, now)
      now += 1000
      reconnectPeer(rib, now)
    }

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.consecutiveFailures).toBe(3)
    expect(peer.syncDeferredUntil).toBeGreaterThan(0)

    // After 3 failures, delay = 5000 * 2^(3-1) = 5000 * 4 = 20000
    // syncDeferredUntil = reconnectTimestamp + 20000
    const expectedDelay = SESSION_FLAP_BASE_DELAY_MS * Math.pow(2, 2)
    expect(peer.syncDeferredUntil).toBe(now + expectedDelay)
  })

  it('delay is capped at SESSION_FLAP_MAX_DELAY_MS', () => {
    const rib = new RoutingInformationBase({ nodeId })
    let now = T0
    createAndConnectPeer(rib, now)

    // 20 close/connect cycles to push past the cap
    for (let i = 0; i < 20; i++) {
      now += 1000
      disconnectPeer(rib, now)
      now += 1000
      reconnectPeer(rib, now)
    }

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.consecutiveFailures).toBe(20)
    expect(peer.syncDeferredUntil).toBeGreaterThan(0)

    // The delay should be exactly the cap
    expect(peer.syncDeferredUntil).toBe(now + SESSION_FLAP_MAX_DELAY_MS)
  })

  it('stable peer for 5 minutes via Tick resets consecutiveFailures (uses lastConnected)', () => {
    const rib = new RoutingInformationBase({ nodeId })
    let now = T0
    createAndConnectPeer(rib, now)

    // Simulate some failures
    now += 1000
    disconnectPeer(rib, now)
    now += 1000
    reconnectPeer(rib, now)
    now += 1000
    disconnectPeer(rib, now)
    now += 1000
    reconnectPeer(rib, now)

    const peerBefore = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerBefore.consecutiveFailures).toBe(2)
    expect(peerBefore.connectionStatus).toBe('connected')

    // Stability check uses lastConnected, NOT lastReceived.
    // Tick past the stability window from lastConnected.
    const tickNow = peerBefore.lastConnected + SESSION_FLAP_STABILITY_MS + 1
    const tickAction: Action = {
      action: Actions.Tick,
      data: { now: tickNow },
    }
    const plan = rib.plan(tickAction, rib.state)
    rib.commit(plan, tickAction)

    const peerAfter = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerAfter.consecutiveFailures).toBe(0)
    expect(peerAfter.lastFailure).toBe(0)
    expect(peerAfter.syncDeferredUntil).toBe(0)
  })

  it('non-flapping peer gets immediate sync (syncDeferredUntil === 0)', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib, T0)

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.connectionStatus).toBe('connected')
    expect(peer.consecutiveFailures).toBe(0)
    expect(peer.syncDeferredUntil).toBe(0)
  })

  it('Tick clears syncDeferredUntil when backoff window expires', () => {
    const rib = new RoutingInformationBase({ nodeId })
    let now = T0
    createAndConnectPeer(rib, now)

    // Create a flapping peer: disconnect + reconnect so sync is deferred
    now += 1000
    disconnectPeer(rib, now)
    now += 1000
    reconnectPeer(rib, now)

    const peerBefore = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerBefore.consecutiveFailures).toBe(1)
    expect(peerBefore.syncDeferredUntil).toBeGreaterThan(0)
    const deferUntil = peerBefore.syncDeferredUntil

    // Tick before deferral expires -- should NOT clear
    const earlyTick: Action = { action: Actions.Tick, data: { now: deferUntil - 1 } }
    const earlyPlan = rib.plan(earlyTick, rib.state)
    rib.commit(earlyPlan, earlyTick)
    const peerStillDeferred = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerStillDeferred.syncDeferredUntil).toBe(deferUntil)

    // Tick at exactly deferral time -- should clear
    const lateTick: Action = { action: Actions.Tick, data: { now: deferUntil } }
    const latePlan = rib.plan(lateTick, rib.state)
    expect(rib.stateChanged(latePlan)).toBe(true)
    rib.commit(latePlan, lateTick)

    const peerAfter = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerAfter.syncDeferredUntil).toBe(0)
    // consecutiveFailures should still be set (only stability reset clears it)
    expect(peerAfter.consecutiveFailures).toBe(1)

    // Confirm prevState vs newState shows the transition
    const prevPeer = latePlan.prevState.internal.peers.find((p) => p.name === peerB.name)!
    expect(prevPeer.syncDeferredUntil).toBe(deferUntil)
    const newPeer = latePlan.newState.internal.peers.find((p) => p.name === peerB.name)!
    expect(newPeer.syncDeferredUntil).toBe(0)
  })
})
