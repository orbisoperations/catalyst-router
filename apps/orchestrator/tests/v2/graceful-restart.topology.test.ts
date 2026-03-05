/**
 * Graceful-restart topology tests for v2 OrchestratorBus.
 *
 * Verifies the stale-route lifecycle:
 *   - TRANSPORT_ERROR close marks routes stale (not immediately withdrawn)
 *   - Reconnect (InternalProtocolConnected) clears the stale flag via fresh route advertisement
 *   - Stale routes are excluded from initial sync to newly connecting peers
 *   - NORMAL close immediately withdraws routes (no stale path)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(name: string): OrchestratorConfig {
  return { node: { name, endpoint: `ws://${name}:4000`, domains: ['gr.local'] } }
}

function makePeer(name: string): PeerInfo {
  return { name, endpoint: `ws://${name}:4000`, domains: ['gr.local'] }
}

const routeX = { name: 'service-x', protocol: 'http' as const, endpoint: 'http://svc-x:8080' }

/** Connect a peer: LocalPeerCreate + InternalProtocolConnected */
async function connectPeer(bus: OrchestratorBus, peerInfo: PeerInfo): Promise<void> {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo } })
}

// ---------------------------------------------------------------------------
// Tests: TRANSPORT_ERROR → stale routes
// ---------------------------------------------------------------------------

describe('Graceful restart: TRANSPORT_ERROR marks routes stale', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })
  })

  it('routes from a peer are marked stale on TRANSPORT_ERROR (not removed)', async () => {
    await connectPeer(bus, makePeer('node-b'))

    // B advertises a route
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    expect(bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(true)

    // Transport error (e.g. WebSocket dropped)
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.TRANSPORT_ERROR },
    })

    // Route must still exist but flagged as stale
    const route = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(route).toBeDefined()
    expect(route?.isStale).toBe(true)
  })

  it('stale routes are retained in the route table (not withdrawn to peers)', async () => {
    const peerC = makePeer('node-c')
    await connectPeer(bus, makePeer('node-b'))
    await connectPeer(bus, peerC)

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })
    transport.reset()

    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.TRANSPORT_ERROR },
    })

    // The stale update is propagated (routeChange type 'updated'), but NOT as 'remove'
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    // If any update was sent, it must not be a 'remove' for service-x
    for (const call of updateCalls) {
      if (call.method !== 'sendUpdate') continue
      const removals = call.message.updates.filter(
        (u) => u.action === 'remove' && u.route.name === 'service-x'
      )
      expect(removals).toHaveLength(0)
    }
  })

  it('NORMAL close immediately removes routes (no stale phase)', async () => {
    await connectPeer(bus, makePeer('node-b'))

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.NORMAL },
    })

    // Route must be gone completely
    expect(bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: Reconnect clears stale flag
// ---------------------------------------------------------------------------

describe('Graceful restart: reconnect clears stale routes', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })
  })

  it('fresh route advertisement from reconnected peer replaces stale route', async () => {
    const peerB = makePeer('node-b')
    await connectPeer(bus, peerB)

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // Drop with transport error → stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(true)

    // Reconnect
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({ action: Actions.InternalProtocolConnected, data: { peerInfo: peerB } })

    // B re-advertises the route
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // Stale flag must be cleared
    const route = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(route).toBeDefined()
    expect(route?.isStale).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: Stale routes excluded from initial sync
// ---------------------------------------------------------------------------

describe('Graceful restart: stale routes excluded from initial sync', () => {
  it('stale routes are NOT sent during initial sync to a newly connecting peer', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })

    // Connect C and learn a route from C
    await connectPeer(bus, makePeer('node-c'))
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-c'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-c'], originNode: 'node-c' }],
        },
      },
    })

    // Transport error on C → route goes stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-c'), code: CloseCodes.TRANSPORT_ERROR },
    })

    const staleRoute = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(staleRoute?.isStale).toBe(true)

    // Now B connects — stale route must NOT appear in the initial sync
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: makePeer('node-b') })
    transport.reset()
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: makePeer('node-b') },
    })

    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    const routeNames = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates.map((u) => u.route.name) : []
    )
    expect(routeNames).not.toContain('service-x')
  })

  it('fresh (non-stale) routes are still included in initial sync after a partial disconnect', async () => {
    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })

    // Connect C and D — learn routes from each
    const routeY = { name: 'service-y', protocol: 'http' as const, endpoint: 'http://svc-y:8080' }
    await connectPeer(bus, makePeer('node-c'))
    await connectPeer(bus, makePeer('node-d'))

    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-c'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-c'], originNode: 'node-c' }],
        },
      },
    })
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-d'),
        update: {
          updates: [{ action: 'add', route: routeY, nodePath: ['node-d'], originNode: 'node-d' }],
        },
      },
    })

    // Only C disconnects with transport error
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-c'), code: CloseCodes.TRANSPORT_ERROR },
    })

    // B connects — should see service-y (fresh) but not service-x (stale)
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: makePeer('node-b') })
    transport.reset()
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: makePeer('node-b') },
    })

    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    const routeNames = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates.map((u) => u.route.name) : []
    )
    expect(routeNames).not.toContain('service-x') // stale — excluded
    expect(routeNames).toContain('service-y') // fresh — included
  })
})
