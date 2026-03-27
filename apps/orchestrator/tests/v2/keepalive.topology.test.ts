/**
 * Keepalive topology tests for v2 OrchestratorBus.
 *
 * Verifies the keepalive lifecycle:
 *   - Connected peers receive keepalives when lastSent is stale (Tick-driven)
 *   - Incoming keepalives (InternalProtocolKeepalive) update lastReceived
 *   - Missed keepalives → hold timer expiry on the next Tick
 *   - Peers with holdTime 0 are exempt from hold-timer expiry
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['keepalive.local'] },
}

const peerBInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['keepalive.local'],
  peerToken: 'token-b',
}

/** Connect a peer: LocalPeerCreate + InternalProtocolConnected */
async function connectPeer(bus: OrchestratorBus, peerInfo: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo } })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Keepalive: outbound keepalive sending', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
    await connectPeer(bus, peerBInfo)
    transport.reset()
  })

  it('sends keepalive to a connected peer when Tick fires and lastSent is stale', async () => {
    const peer = bus.state.internal.peers.get('node-b')
    expect(peer).toBeDefined()
    const holdTime = peer!.holdTime
    const lastReceived = peer!.lastReceived
    // Advance time past holdTime/3 but NOT past holdTime (to avoid expiry)
    const now = lastReceived + Math.floor(holdTime / 3) + 1

    await bus.dispatch({ action: Actions.Tick, data: { now } })

    const keepaliveCalls = transport.getCallsFor('sendKeepalive')
    expect(keepaliveCalls).toHaveLength(1)
    expect(keepaliveCalls[0].peer.name).toBe('node-b')
  })

  it('does not send keepalive again before holdTime / 3 elapses', async () => {
    const peer = bus.state.internal.peers.get('node-b')!
    const holdTime = peer.holdTime
    const lastReceived = peer.lastReceived
    // t1 is past holdTime/3 (triggers keepalive) but well before holdTime (no expiry)
    const t1 = lastReceived + Math.floor(holdTime / 3) + 1

    // First Tick — sends keepalive and records lastSent = t1
    await bus.dispatch({ action: Actions.Tick, data: { now: t1 } })
    transport.reset()

    // Second Tick immediately after — not enough time has elapsed
    const t2 = t1 + 100
    await bus.dispatch({ action: Actions.Tick, data: { now: t2 } })

    expect(transport.getCallsFor('sendKeepalive')).toHaveLength(0)
  })

  it('sends keepalive again after holdTime / 3 elapses from last send', async () => {
    const peer = bus.state.internal.peers.get('node-b')!
    const holdTime = peer.holdTime
    const lastReceived = peer.lastReceived
    // t1 is past holdTime/3 but NOT past holdTime (avoids expiry)
    const t1 = lastReceived + Math.floor(holdTime / 3) + 1

    // First Tick — sends keepalive, records lastSent = t1
    await bus.dispatch({ action: Actions.Tick, data: { now: t1 } })
    transport.reset()

    // t2 is holdTime/3 + 1ms after t1, still safely below holdTime expiry
    const t2 = t1 + Math.ceil(holdTime / 3) + 1
    await bus.dispatch({ action: Actions.Tick, data: { now: t2 } })

    expect(transport.getCallsFor('sendKeepalive')).toHaveLength(1)
  })

  it('does not send keepalive to a peer with holdTime 0', async () => {
    // Create a second peer with holdTime 0 (keepalive-disabled session)
    const peerC: PeerInfo = {
      name: 'node-c',
      endpoint: 'ws://node-c:4000',
      domains: ['keepalive.local'],
      peerToken: 'token-c',
    }
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    // Override holdTime via InternalProtocolOpen with holdTime: 0
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerC, holdTime: 0 },
    })
    transport.reset()

    // Tick far in the future
    await bus.dispatch({ action: Actions.Tick, data: { now: Date.now() + 999_999 } })

    const keepaliveCalls = transport.getCallsFor('sendKeepalive')
    // node-c must not receive keepalive (holdTime 0)
    const sentToC = keepaliveCalls.filter((c) => c.peer.name === 'node-c')
    expect(sentToC).toHaveLength(0)
  })

  it('does not send keepalive to a disconnected (closed) peer', async () => {
    // Close the peer first
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerBInfo, code: 1 },
    })
    transport.reset()

    await bus.dispatch({ action: Actions.Tick, data: { now: Date.now() + 999_999 } })

    expect(transport.getCallsFor('sendKeepalive')).toHaveLength(0)
  })

  it('keepalive transport failure is swallowed (fire-and-forget)', async () => {
    transport.setShouldFail(true)
    const holdTime = bus.state.internal.peers.get('node-b')?.holdTime ?? 90_000

    // Should not throw even when transport fails
    await expect(
      bus.dispatch({ action: Actions.Tick, data: { now: Date.now() + holdTime } })
    ).resolves.toBeDefined()
  })
})

describe('Keepalive: incoming keepalive updates lastReceived', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
    await connectPeer(bus, peerBInfo)
  })

  it('dispatching InternalProtocolKeepalive updates lastReceived on the peer', async () => {
    const before = bus.state.internal.peers.get('node-b')?.lastReceived ?? 0

    await bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: peerBInfo },
    })

    const after = bus.state.internal.peers.get('node-b')?.lastReceived ?? 0
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('keepalive from unknown peer is a no-op', async () => {
    const unknownPeer: PeerInfo = {
      name: 'node-unknown',
      endpoint: 'ws://unknown:4000',
      domains: ['keepalive.local'],
    }

    const result = await bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: unknownPeer },
    })

    // Unknown peer → no state change
    expect(result.success).toBe(false)
  })
})

describe('Keepalive: hold timer expiry on missed keepalives', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
    await connectPeer(bus, peerBInfo)
    transport.reset()
  })

  it('peer expires when Tick fires after holdTime has elapsed since lastReceived', async () => {
    const peer = bus.state.internal.peers.get('node-b')
    expect(peer).toBeDefined()
    const holdTime = peer!.holdTime // 90_000 by default
    const lastReceived = peer!.lastReceived

    // Tick at lastReceived + holdTime + 1 ms → hold timer expired
    const now = lastReceived + holdTime + 1
    const result = await bus.dispatch({ action: Actions.Tick, data: { now } })

    expect(result.success).toBe(true)
    // Peer should now be closed
    const peerAfter = bus.state.internal.peers.get('node-b')
    expect(peerAfter?.connectionStatus).toBe('closed')
  })

  it('peer does NOT expire when Tick fires before holdTime has elapsed', async () => {
    const peer = bus.state.internal.peers.get('node-b')!
    const now = peer.lastReceived + peer.holdTime - 1 // 1ms before expiry

    const result = await bus.dispatch({ action: Actions.Tick, data: { now } })

    // No state change — peer is still alive
    expect(result.success).toBe(false)
    const peerAfter = bus.state.internal.peers.get('node-b')
    expect(peerAfter?.connectionStatus).toBe('connected')
  })

  it('hold timer expiry removes peer routes and notifies connected peers', async () => {
    // Give B a short holdTime (3 s) so we can expire it independently from C.
    // InternalProtocolOpen negotiates min(existing, requested): 90_000 vs 3_000 → 3_000.
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerBInfo, holdTime: 3_000 },
    })

    // Add C (default holdTime 90_000 — will NOT expire at B's +3001ms tick)
    const peerC: PeerInfo = {
      name: 'node-c',
      endpoint: 'ws://node-c:4000',
      domains: ['keepalive.local'],
      peerToken: 'token-c',
    }
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerC } })

    // Receive a route from B
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerBInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'svc-b', protocol: 'http', endpoint: 'http://svc-b:8080' },
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })
    transport.reset()

    // Expire B's short hold timer (3_000ms). C has 90_000ms holdTime → still alive.
    const peerB = bus.state.internal.peers.get('node-b')!
    expect(peerB.holdTime).toBe(3_000)
    const expiryNow = peerB.lastReceived + 3_001

    await bus.dispatch({ action: Actions.Tick, data: { now: expiryNow } })

    // B's route should be gone
    expect([...bus.state.internal.routes.values()].flatMap((m) => [...m.values()]).some((r) => r.name === 'svc-b')).toBe(false)

    // Withdrawal should have been sent to C
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    const update = updateCalls[0]
    if (update.method !== 'sendUpdate') throw new Error('wrong type')
    expect(
      update.message.updates.some((u) => u.action === 'remove' && u.route.name === 'svc-b')
    ).toBe(true)
  })

  it('peer with holdTime 0 never expires regardless of lastReceived age', async () => {
    // Override holdTime to 0 via InternalProtocolOpen
    const peerC: PeerInfo = {
      name: 'node-c',
      endpoint: 'ws://node-c:4000',
      domains: ['keepalive.local'],
      peerToken: 'token-c',
    }
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: peerC, holdTime: 0 },
    })

    // Confirm holdTime is 0
    const peer = bus.state.internal.peers.get('node-c')
    expect(peer?.holdTime).toBe(0)

    // Tick far in the future — peer should not expire
    await bus.dispatch({ action: Actions.Tick, data: { now: Date.now() + 999_999_999 } })

    const peerAfter = bus.state.internal.peers.get('node-c')
    expect(peerAfter?.connectionStatus).toBe('connected')
  })
})
