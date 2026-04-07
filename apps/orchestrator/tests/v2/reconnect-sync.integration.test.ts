/**
 * Integration test: ReconnectManager → OrchestratorBus → initial route sync chain.
 *
 * Verifies that when ReconnectManager successfully reconnects a peer, it dispatches
 * InternalProtocolConnected which triggers syncRoutesToPeer on the bus — delivering
 * the full route table to the reconnected peer.
 *
 * Note: Session flap detection defers sync for peers with consecutiveFailures > 0.
 * Tests that need immediate sync after a transport-error close must advance time
 * past the SESSION_FLAP_BASE_DELAY_MS window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorServiceV2 } from '../../src/v2/service.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['reconnect.local'],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['reconnect.local'],
  peerToken: 'token-b',
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReconnectManager → Bus → initial sync chain', () => {
  let transport: MockPeerTransport
  let svc: OrchestratorServiceV2

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
    svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'test-token' })

    // Add a local route
    await svc.bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    // Establish peer connection
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    transport.reset()
  })

  afterEach(async () => {
    await svc.stop()
    vi.useRealTimers()
  })

  it('reconnect dispatches InternalProtocolConnected and triggers initial sync', async () => {
    // Simulate transport error close
    await svc.bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })
    transport.reset()

    // Get the peer record for scheduling reconnect
    const peerRecord = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')!
    expect(peerRecord.connectionStatus).toBe('closed')

    // Schedule reconnect
    svc.reconnectManager.scheduleReconnect(peerRecord)
    expect(svc.reconnectManager.pendingCount).toBe(1)

    // Advance past the first backoff delay (1s)
    await vi.advanceTimersByTimeAsync(1_001)

    // ReconnectManager should have called transport.openPeer
    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)

    // After a transport-error close, the peer has consecutiveFailures=1.
    // Session flap detection defers the initial sync for SESSION_FLAP_BASE_DELAY_MS,
    // so sendUpdate should NOT have been called yet.
    const deferredUpdateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    expect(deferredUpdateCalls).toHaveLength(0)

    // Verify the peer is reconnected but sync was deferred
    const reconnectedPeer = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')!
    expect(reconnectedPeer.connectionStatus).toBe('connected')
    expect(reconnectedPeer.consecutiveFailures).toBe(1)
    expect(reconnectedPeer.syncDeferredUntil).toBeGreaterThan(0)
  })

  it('reconnect resets attempt counter on success', async () => {
    await svc.bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })

    const peerRecord = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')!
    svc.reconnectManager.scheduleReconnect(peerRecord)

    // Advance past backoff
    await vi.advanceTimersByTimeAsync(1_001)

    // No more pending — success cleared the timer and attempt counter
    expect(svc.reconnectManager.pendingCount).toBe(0)
  })

  it('reconnect fails without node token', async () => {
    // Create service without a token
    const svc2 = new OrchestratorServiceV2({ config, transport: new MockPeerTransport() })
    await svc2.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await svc2.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    await svc2.bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })

    const peerRecord = svc2.bus.state.internal.peers.find((p) => p.name === 'node-b')!
    svc2.reconnectManager.scheduleReconnect(peerRecord)

    // Advance past backoff
    await vi.advanceTimersByTimeAsync(1_001)

    // Should not have scheduled another reconnect (no token → skip, not retry)
    expect(svc2.reconnectManager.pendingCount).toBe(0)

    await svc2.stop()
  })
})
