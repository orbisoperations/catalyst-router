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

/** Add peer via LocalPeerCreate, then connect via InternalProtocolConnected */
function createAndConnectPeer(rib: RoutingInformationBase): void {
  const create: Action = {
    action: Actions.LocalPeerCreate,
    data: peerB,
  }
  const p1 = rib.plan(create, rib.state)
  rib.commit(p1, create)

  const connect: Action = {
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerB },
  }
  const p2 = rib.plan(connect, rib.state)
  rib.commit(p2, connect)
}

/** Disconnect peer via InternalProtocolClose with transport error */
function disconnectPeer(rib: RoutingInformationBase): void {
  const close: Action = {
    action: Actions.InternalProtocolClose,
    data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR, reason: 'disconnect' },
  }
  const plan = rib.plan(close, rib.state)
  rib.commit(plan, close)
}

/** Reconnect peer via InternalProtocolConnected */
function reconnectPeer(rib: RoutingInformationBase): void {
  const connect: Action = {
    action: Actions.InternalProtocolConnected,
    data: { peerInfo: peerB },
  }
  const plan = rib.plan(connect, rib.state)
  rib.commit(plan, connect)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session flap detection (RFC 4271 §8 / BIRD error-wait)', () => {
  it('first disconnect sets consecutiveFailures to 1', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib)

    // Verify connected and zero failures
    const peerBefore = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerBefore.connectionStatus).toBe('connected')
    expect(peerBefore.consecutiveFailures).toBe(0)

    // Disconnect
    disconnectPeer(rib)

    const peerAfter = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerAfter.connectionStatus).toBe('closed')
    expect(peerAfter.consecutiveFailures).toBe(1)
    expect(peerAfter.lastFailure).toBeGreaterThan(0)
  })

  it('third consecutive reconnect has sync deferred with expected delay', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib)

    // 3 close/connect cycles
    for (let i = 0; i < 3; i++) {
      disconnectPeer(rib)
      reconnectPeer(rib)
    }

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.consecutiveFailures).toBe(3)
    expect(peer.syncDeferredUntil).toBeGreaterThan(0)

    // After 3 failures, delay = 5000 * 2^(3-1) = 5000 * 4 = 20000
    // syncDeferredUntil = Date.now() + 20000, so the delta should be ~20000
    const now = Date.now()
    const delta = peer.syncDeferredUntil - now
    // Allow some slack for test execution time (within 1 second)
    expect(delta).toBeGreaterThan(SESSION_FLAP_BASE_DELAY_MS * Math.pow(2, 2) - 1000)
    expect(delta).toBeLessThanOrEqual(SESSION_FLAP_BASE_DELAY_MS * Math.pow(2, 2) + 1000)
  })

  it('delay is capped at SESSION_FLAP_MAX_DELAY_MS', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib)

    // 20 close/connect cycles to push past the cap
    for (let i = 0; i < 20; i++) {
      disconnectPeer(rib)
      reconnectPeer(rib)
    }

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.consecutiveFailures).toBe(20)
    expect(peer.syncDeferredUntil).toBeGreaterThan(0)

    const now = Date.now()
    const delta = peer.syncDeferredUntil - now
    expect(delta).toBeLessThanOrEqual(SESSION_FLAP_MAX_DELAY_MS + 1000)
  })

  it('stable peer for 5 minutes via Tick resets consecutiveFailures', () => {
    const rib = new RoutingInformationBase({ nodeId })
    createAndConnectPeer(rib)

    // Simulate some failures
    disconnectPeer(rib)
    reconnectPeer(rib)
    disconnectPeer(rib)
    reconnectPeer(rib)

    const peerBefore = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peerBefore.consecutiveFailures).toBe(2)
    expect(peerBefore.connectionStatus).toBe('connected')

    // Dispatch Tick well past the stability window.
    // The stability check uses lastReceived, so we need it to be older than
    // SESSION_FLAP_STABILITY_MS from tick's `now`.
    const tickNow = peerBefore.lastReceived + SESSION_FLAP_STABILITY_MS + 1
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
    createAndConnectPeer(rib)

    const peer = rib.state.internal.peers.find((p) => p.name === peerB.name)!
    expect(peer.connectionStatus).toBe('connected')
    expect(peer.consecutiveFailures).toBe(0)
    expect(peer.syncDeferredUntil).toBe(0)
  })
})
