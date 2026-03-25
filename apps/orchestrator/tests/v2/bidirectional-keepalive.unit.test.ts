/**
 * Integration test: bidirectional keepalive exchange between two bus instances.
 *
 * The unit-level keepalive tests verify single-bus behavior. This test wires two
 * OrchestratorBus instances together via TopologyHelper-style propagation to verify:
 * - Keepalive from A received at B resets B's hold timer for A
 * - Hold timer expires when keepalives stop flowing
 *
 * Uses vi.useFakeTimers() to control Date.now() for deterministic lastReceived values.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(name: string): OrchestratorConfig {
  return {
    node: { name, endpoint: `ws://${name}:4000`, domains: ['keepalive-bidi.local'] },
  }
}

function makePeerInfo(name: string): PeerInfo {
  return {
    name,
    endpoint: `ws://${name}:4000`,
    domains: ['keepalive-bidi.local'],
    peerToken: `token-${name}`,
  }
}

interface BusEntry {
  name: string
  bus: OrchestratorBus
  transport: MockPeerTransport
  peerInfo: PeerInfo
}

/**
 * Deliver keepalive calls from one bus's transport to the other bus
 * as InternalProtocolKeepalive dispatches.
 */
async function propagateKeepalives(from: BusEntry, to: BusEntry): Promise<void> {
  const consumed: TransportCall[] = []
  const remaining: TransportCall[] = []

  for (const call of from.transport.calls) {
    if (call.method === 'sendKeepalive' && call.peer.name === to.name) {
      consumed.push(call)
    } else {
      remaining.push(call)
    }
  }

  from.transport.calls.length = 0
  for (const c of remaining) {
    from.transport.calls.push(c)
  }

  for (const _call of consumed) {
    await to.bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: from.peerInfo },
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bidirectional keepalive exchange', () => {
  const HOLD_TIME = 3_000
  const T0 = 1_000_000_000_000 // fixed base time

  let a: BusEntry
  let b: BusEntry

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0 })

    const transportA = new MockPeerTransport()
    const transportB = new MockPeerTransport()

    a = {
      name: 'node-a',
      bus: new OrchestratorBus({ config: makeConfig('node-a'), transport: transportA }),
      transport: transportA,
      peerInfo: makePeerInfo('node-a'),
    }
    b = {
      name: 'node-b',
      bus: new OrchestratorBus({ config: makeConfig('node-b'), transport: transportB }),
      transport: transportB,
      peerInfo: makePeerInfo('node-b'),
    }

    // Peer A↔B: connect first, then negotiate short holdTime.
    // InternalProtocolConnected resets holdTime to 90_000, so we negotiate after.
    await a.bus.dispatch({ action: Actions.LocalPeerCreate, data: b.peerInfo })
    await b.bus.dispatch({ action: Actions.LocalPeerCreate, data: a.peerInfo })

    await a.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: b.peerInfo },
    })
    await b.bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: a.peerInfo },
    })

    // Now negotiate holdTime (Open after Connected, as existing tests do)
    await a.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: b.peerInfo, holdTime: HOLD_TIME },
    })
    await b.bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: a.peerInfo, holdTime: HOLD_TIME },
    })

    a.transport.reset()
    b.transport.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keepalive from A resets B hold timer for A — preventing expiry', async () => {
    const peerAonB = b.bus.state.internal.peers.find((p) => p.name === 'node-a')!
    expect(peerAonB.holdTime).toBe(HOLD_TIME)
    expect(peerAonB.lastReceived).toBe(T0)

    // Advance time to holdTime/3 + 1ms → A sends keepalive
    const t1 = T0 + Math.floor(HOLD_TIME / 3) + 1
    vi.setSystemTime(t1)
    await a.bus.dispatch({ action: Actions.Tick, data: { now: t1 } })

    // Deliver A's keepalive to B — this updates B's lastReceived for A to Date.now() = t1
    await propagateKeepalives(a, b)

    const peerAonBUpdated = b.bus.state.internal.peers.find((p) => p.name === 'node-a')!
    expect(peerAonBUpdated.lastReceived).toBe(t1)

    // Tick B at original expiry time (T0 + holdTime + 1).
    // Without the keepalive, this would expire A. With it, lastReceived = t1,
    // so expiry is t1 + holdTime = much later. A should survive.
    const wouldExpireOriginal = T0 + HOLD_TIME + 1
    await b.bus.dispatch({ action: Actions.Tick, data: { now: wouldExpireOriginal } })

    const peerAonBAfter = b.bus.state.internal.peers.find((p) => p.name === 'node-a')
    expect(peerAonBAfter?.connectionStatus).toBe('connected')
  })

  it('hold timer expires when keepalives stop flowing', async () => {
    const peerAonB = b.bus.state.internal.peers.find((p) => p.name === 'node-a')!
    expect(peerAonB.holdTime).toBe(HOLD_TIME)

    // Tick past hold timer without any keepalives
    const expiryTime = T0 + HOLD_TIME + 1
    await b.bus.dispatch({ action: Actions.Tick, data: { now: expiryTime } })

    const peerAonBAfter = b.bus.state.internal.peers.find((p) => p.name === 'node-a')
    expect(peerAonBAfter?.connectionStatus).toBe('closed')
  })

  it('bidirectional keepalive exchange keeps both peers alive past holdTime', async () => {
    // Simulate several keepalive rounds, each at holdTime/3 intervals
    const interval = Math.floor(HOLD_TIME / 3) + 1

    for (let round = 1; round <= 4; round++) {
      const now = T0 + interval * round
      vi.setSystemTime(now)

      // Both sides tick — generates outbound keepalives
      await a.bus.dispatch({ action: Actions.Tick, data: { now } })
      await b.bus.dispatch({ action: Actions.Tick, data: { now } })

      // Deliver keepalives bidirectionally
      await propagateKeepalives(a, b)
      await propagateKeepalives(b, a)
    }

    // After 4 rounds (~4s), both peers should still be connected
    // (they would have expired at 3s without keepalives)
    const totalElapsed = interval * 4
    expect(totalElapsed).toBeGreaterThan(HOLD_TIME) // sanity: we're past expiry window

    const peerBonAFinal = a.bus.state.internal.peers.find((p) => p.name === 'node-b')
    const peerAonBFinal = b.bus.state.internal.peers.find((p) => p.name === 'node-a')

    expect(peerBonAFinal?.connectionStatus).toBe('connected')
    expect(peerAonBFinal?.connectionStatus).toBe('connected')
  })
})
