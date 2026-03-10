/**
 * Integration test: TickManager ↔ OrchestratorServiceV2 tick interval recalculation.
 *
 * Verifies the monkey-patched dispatch in OrchestratorServiceV2 that calls
 * recalculateTickInterval() after InternalProtocolOpen and InternalProtocolConnected.
 * Also documents that hold-timer expiry does NOT auto-reconnect (intentional design).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorServiceV2 } from '../../src/v2/service.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['tick.local'],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['tick.local'],
  peerToken: 'token-b',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tick interval recalculation via OrchestratorServiceV2', () => {
  let transport: MockPeerTransport
  let svc: OrchestratorServiceV2

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
    svc = new OrchestratorServiceV2({ config, transport })
    svc.start()
  })

  afterEach(async () => {
    await svc.stop()
    vi.useRealTimers()
  })

  it('starts with default tick interval (30s)', () => {
    expect(svc.tickManager.currentIntervalMs).toBe(30_000)
  })

  it('recalculates tick interval after InternalProtocolOpen with custom holdTime', async () => {
    // Add peer first
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    // Open with holdTime 9000 → tick should be 9000/3 = 3000ms
    await svc.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerB, holdTime: 9_000 },
    })

    expect(svc.tickManager.currentIntervalMs).toBe(3_000)
  })

  it('recalculates tick interval after InternalProtocolConnected', async () => {
    // Add peer with custom holdTime via Open first
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerB, holdTime: 12_000 },
    })

    expect(svc.tickManager.currentIntervalMs).toBe(4_000) // 12000/3

    // Simulate disconnect and reconnect — holdTime resets to 90_000 default
    await svc.bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: 1 },
    })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })

    // After reconnect, holdTime resets to 90_000 → tick = 30_000
    expect(svc.tickManager.currentIntervalMs).toBe(30_000)
  })

  it('uses minimum holdTime across multiple peers for tick interval', async () => {
    const peerC: PeerInfo = {
      name: 'node-c',
      endpoint: 'ws://node-c:4000',
      domains: ['tick.local'],
      peerToken: 'token-c',
    }

    // Add two peers with different holdTimes
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerB, holdTime: 15_000 },
    })

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerC, holdTime: 9_000 },
    })

    // Minimum holdTime is 9_000 → tick = 3_000
    expect(svc.tickManager.currentIntervalMs).toBe(3_000)
  })
})

describe('Hold-timer expiry does NOT auto-reconnect (documents intentional design)', () => {
  let transport: MockPeerTransport
  let svc: OrchestratorServiceV2

  beforeEach(async () => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
    svc = new OrchestratorServiceV2({ config, transport })
    svc.start()

    // Connect a peer, then negotiate short holdTime (3s).
    // InternalProtocolConnected resets holdTime to 90_000, so we must negotiate
    // AFTER connect via a second InternalProtocolOpen.
    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    await svc.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerB, holdTime: 3_000 },
    })
  })

  afterEach(async () => {
    await svc.stop()
    vi.useRealTimers()
  })

  it('expired peer closes but reconnectManager has no pending reconnects', async () => {
    const peer = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')!
    expect(peer.connectionStatus).toBe('connected')

    // Expire the peer via Tick
    const expiryNow = peer.lastReceived + 3_001
    await svc.bus.dispatch({ action: Actions.Tick, data: { now: expiryNow } })

    const peerAfter = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peerAfter?.connectionStatus).toBe('closed')

    // ReconnectManager should NOT have auto-scheduled a reconnect
    expect(svc.reconnectManager.pendingCount).toBe(0)
  })
})
