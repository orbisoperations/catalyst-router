/**
 * Tests for GAP-001: auto-dial on LocalPeerCreate.
 *
 * When a peer is created via LocalPeerCreate and the service has a nodeToken
 * and the peer has an endpoint, the service should automatically call
 * transport.openPeer() to establish the connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorServiceV2 } from '../../src/v2/service.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { InMemoryActionLog, RoutingInformationBase, Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['auto-dial.local'],
  },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['auto-dial.local'],
  peerToken: 'token-b',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto-dial on LocalPeerCreate', () => {
  let transport: MockPeerTransport
  let svc: OrchestratorServiceV2

  beforeEach(() => {
    vi.useFakeTimers()
    transport = new MockPeerTransport()
  })

  afterEach(async () => {
    if (svc) await svc.stop()
    vi.useRealTimers()
  })

  it('LocalPeerCreate calls transport.openPeer with the node token', async () => {
    svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'test-token' })

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)
    expect(openCalls[0]).toMatchObject({
      method: 'openPeer',
      token: 'test-token',
    })
    // Verify it was called with the correct peer name
    if (openCalls[0].method === 'openPeer') {
      expect(openCalls[0].peer.name).toBe('node-b')
    }
  })

  it('successful dial dispatches InternalProtocolConnected', async () => {
    svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'test-token' })

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    const peer = svc.bus.state.internal.peers.find((p) => p.name === 'node-b')
    expect(peer).toBeDefined()
    expect(peer!.connectionStatus).toBe('connected')
  })

  it('LocalPeerCreate with no endpoint does NOT call openPeer', async () => {
    svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'test-token' })

    const peerNoEndpoint: PeerInfo = {
      name: 'node-c',
      domains: ['auto-dial.local'],
    }

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerNoEndpoint })

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(0)
  })

  it('LocalPeerCreate with no nodeToken does NOT call openPeer', async () => {
    svc = new OrchestratorServiceV2({ config, transport })

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(0)
  })

  it('failed dial schedules reconnect via ReconnectManager', async () => {
    svc = new OrchestratorServiceV2({ config, transport, nodeToken: 'test-token' })

    transport.setShouldFail(true)

    await svc.bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    // openPeer was attempted
    const openCalls = transport.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(1)

    // Failed dial should have scheduled a reconnect
    expect(svc.reconnectManager.pendingCount).toBe(1)
  })

  it('journal replay does NOT trigger auto-dial', async () => {
    // Session 1: create peer via dispatch
    const journal = new InMemoryActionLog()
    const tempRib = new RoutingInformationBase({ nodeId: config.node.name })

    // Simulate a journal entry from a previous session
    const action = { action: Actions.LocalPeerCreate, data: peerB }
    journal.append(action, 'node-a')

    // Replay to get initial state (same logic the service uses)
    for (const entry of journal.replay()) {
      const plan = tempRib.plan(entry.action, tempRib.state)
      if (tempRib.stateChanged(plan)) {
        tempRib.commit(plan, entry.action)
      }
    }

    // Session 2: create a NEW service with the replayed state
    const transport2 = new MockPeerTransport()
    const { OrchestratorBus } = await import('../../src/v2/bus.js')

    // Build the bus directly with replayed state — this is what the service
    // constructor does internally when it replays the journal.
    const bus = new OrchestratorBus({
      config,
      transport: transport2,
      journal,
      initialState: tempRib.state,
      nodeToken: 'test-token',
    })

    // The peer is in state from replay
    expect(bus.state.internal.peers.find((p) => p.name === 'node-b')).toBeDefined()

    // But no openPeer call was made — replay does not trigger auto-dial
    const openCalls = transport2.getCallsFor('openPeer')
    expect(openCalls).toHaveLength(0)
  })
})
