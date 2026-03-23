import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['close.local'] },
}

const peerB: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['close.local'],
  peerToken: 'token-b',
}

const peerC: PeerInfo = {
  name: 'node-c',
  endpoint: 'ws://node-c:4000',
  domains: ['close.local'],
  peerToken: 'token-c',
}

const routeAlpha = { name: 'alpha', protocol: 'http' as const, endpoint: 'http://alpha:8080' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectPeer(bus: OrchestratorBus, peer: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peer } })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('closePeer on LocalPeerDelete', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config, transport })
  })

  it('LocalPeerDelete sends closePeer to the deleted peer', async () => {
    await connectPeer(bus, peerB)
    transport.reset()

    await bus.dispatch({ action: Actions.LocalPeerDelete, data: { name: 'node-b' } })

    const closeCalls = transport.getCallsFor('closePeer')
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0].peer.name).toBe('node-b')
    if (closeCalls[0].method === 'closePeer') {
      expect(closeCalls[0].code).toBe(CloseCodes.NORMAL)
    }
  })

  it('closePeer fires AND withdrawals propagate to remaining peers', async () => {
    await connectPeer(bus, peerB)
    await connectPeer(bus, peerC)

    // Receive a route from B
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })
    transport.reset()

    await bus.dispatch({ action: Actions.LocalPeerDelete, data: { name: 'node-b' } })

    // closePeer called for B
    const closeCalls = transport.getCallsFor('closePeer')
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0].peer.name).toBe('node-b')

    // withdrawal sent to C
    const updateCalls = transport.getCallsFor('sendUpdate')
    const sentToC = updateCalls.filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(sentToC.length).toBeGreaterThanOrEqual(1)
    if (sentToC[0].method === 'sendUpdate') {
      expect(sentToC[0].message.updates[0].action).toBe('remove')
      expect(sentToC[0].message.updates[0].route.name).toBe('alpha')
    }
  })

  it('delete of nonexistent peer does not call closePeer', async () => {
    const result = await bus.dispatch({
      action: Actions.LocalPeerDelete,
      data: { name: 'nonexistent' },
    })

    expect(result.success).toBe(false)
    expect(transport.getCallsFor('closePeer')).toHaveLength(0)
  })

  it('closePeer failure does not block withdrawal propagation', async () => {
    await connectPeer(bus, peerB)
    await connectPeer(bus, peerC)

    // Receive a route from B
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    // Make closePeer throw
    vi.spyOn(transport, 'closePeer').mockRejectedValueOnce(new Error('network error'))
    transport.calls.length = 0

    const result = await bus.dispatch({
      action: Actions.LocalPeerDelete,
      data: { name: 'node-b' },
    })

    // dispatch resolves without throwing
    expect(result.success).toBe(true)

    // withdrawal still sent to C
    const updateCalls = transport.getCallsFor('sendUpdate')
    const sentToC = updateCalls.filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(sentToC.length).toBeGreaterThanOrEqual(1)
  })

  it('delete of initializing peer still fires closePeer', async () => {
    // Create peer B but do NOT connect (stays initializing)
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    transport.reset()

    await bus.dispatch({ action: Actions.LocalPeerDelete, data: { name: 'node-b' } })

    const closeCalls = transport.getCallsFor('closePeer')
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0].peer.name).toBe('node-b')
  })
})
