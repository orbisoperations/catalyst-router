/**
 * Graceful-restart topology tests for v2 OrchestratorBus.
 *
 * Verifies the stale-route lifecycle:
 *   - TRANSPORT_ERROR close marks routes stale (not immediately withdrawn)
 *   - Reconnect (InternalProtocolConnected) clears the stale flag via fresh route advertisement
 *   - Stale routes are excluded from initial sync to newly connecting peers
 *   - NORMAL close immediately withdraws routes (no stale path)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { Action } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(name: string): OrchestratorConfig {
  return { node: { name, endpoint: `ws://${name}:4000`, domains: ['gr.local'] } }
}

function makePeer(name: string): PeerInfo {
  return { name, endpoint: `ws://${name}:4000`, domains: ['gr.local'], peerToken: `token-${name}` }
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

// ---------------------------------------------------------------------------
// Tests: Hold-timer purge of stale routes
// ---------------------------------------------------------------------------

describe('Graceful restart: hold-timer purge of stale routes', () => {
  const BASE_NOW = 1_700_000_000_000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stale routes are purged after holdTime elapses, and withdrawal is sent to peers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW)

    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })

    // Connect peers B and C
    await connectPeer(bus, makePeer('node-b'))
    await connectPeer(bus, makePeer('node-c'))

    // B advertises service-x
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // Verify route exists
    expect(bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(true)

    // Transport error on B — routes go stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.TRANSPORT_ERROR },
    })

    const staleRoute = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(staleRoute).toBeDefined()
    expect(staleRoute?.isStale).toBe(true)

    // Keep node-c alive: send a keepalive from C right before the Tick
    // so its hold timer doesn't also expire.
    const peerB = bus.state.internal.peers.find((p) => p.name === 'node-b')!
    const tickTime = peerB.lastReceived + peerB.holdTime + 1_000
    vi.spyOn(Date, 'now').mockReturnValue(tickTime - 1_000)
    await bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: makePeer('node-c') },
    })

    // Reset transport to track only the withdrawal
    transport.reset()

    // Dispatch Tick past B's holdTime — B is closed with stale routes, so they are purged
    await bus.dispatch({ action: Actions.Tick, data: { now: tickTime } })

    // Route must be purged
    expect(bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(false)

    // Withdrawal must have been sent to node-c
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    const removals = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate'
        ? c.message.updates.filter((u) => u.action === 'remove' && u.route.name === 'service-x')
        : []
    )
    expect(removals.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Partial refresh — only re-advertised routes survive
// ---------------------------------------------------------------------------

describe('Graceful restart: partial refresh — only re-advertised routes survive', () => {
  const BASE_NOW = 1_700_000_000_000
  const routeY = { name: 'service-y', protocol: 'http' as const, endpoint: 'http://svc-y:8080' }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-advertised routes are refreshed, non-re-advertised routes remain stale and are purged on next disconnect', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW)

    const transport = new MockPeerTransport()
    const bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })

    // Connect peer B
    await connectPeer(bus, makePeer('node-b'))

    // B advertises both service-x and service-y
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [
            { action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' },
            { action: 'add', route: routeY, nodePath: ['node-b'], originNode: 'node-b' },
          ],
        },
      },
    })

    expect(bus.state.internal.routes.filter((r) => r.peer.name === 'node-b')).toHaveLength(2)

    // Transport error on B — both routes go stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.TRANSPORT_ERROR },
    })

    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(true)
    expect(bus.state.internal.routes.find((r) => r.name === 'service-y')?.isStale).toBe(true)

    // B reconnects
    const reconnectTime = BASE_NOW + 5_000
    vi.spyOn(Date, 'now').mockReturnValue(reconnectTime)
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: makePeer('node-b') })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: makePeer('node-b') },
    })

    // B re-advertises ONLY service-x (not service-y)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: makePeer('node-b'),
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // service-x is refreshed (stale cleared), service-y is still stale
    const refreshedX = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(refreshedX).toBeDefined()
    expect(refreshedX?.isStale).toBe(false)

    const stillStaleY = bus.state.internal.routes.find((r) => r.name === 'service-y')
    expect(stillStaleY).toBeDefined()
    expect(stillStaleY?.isStale).toBe(true)

    // B drops again with TRANSPORT_ERROR.
    // service-x (fresh) becomes stale, service-y was already stale and stays stale.
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeer('node-b'), code: CloseCodes.TRANSPORT_ERROR },
    })

    // Both routes are stale now, peer is closed.
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(true)
    expect(bus.state.internal.routes.find((r) => r.name === 'service-y')?.isStale).toBe(true)

    // Dispatch Tick past holdTime — peer is closed, stale routes are purged
    const peer = bus.state.internal.peers.find((p) => p.name === 'node-b')!
    const tickTime = peer.lastReceived + peer.holdTime + 1_000
    await bus.dispatch({ action: Actions.Tick, data: { now: tickTime } })

    // Both stale routes from the closed peer are purged
    expect(bus.state.internal.routes.find((r) => r.name === 'service-y')).toBeUndefined()
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: End-of-RIB purges remaining stale routes
// ---------------------------------------------------------------------------

describe('Graceful restart: End-of-RIB purges remaining stale routes', () => {
  const routeY = { name: 'service-y', protocol: 'http' as const, endpoint: 'http://svc-y:8080' }
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(async () => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: makeConfig('node-a'), transport })
  })

  it('EoR purges remaining stale routes from reconnected peer', async () => {
    const peerB = makePeer('node-b')
    await connectPeer(bus, peerB)

    // B advertises route-x and route-y
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            { action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' },
            { action: 'add', route: routeY, nodePath: ['node-b'], originNode: 'node-b' },
          ],
        },
      },
    })

    expect(bus.state.internal.routes).toHaveLength(2)

    // Transport error — both routes go stale
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })

    expect(bus.state.internal.routes.every((r) => r.isStale === true)).toBe(true)

    // B reconnects
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })

    // B re-advertises ONLY route-x (route-y is gone from B)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // route-x refreshed, route-y still stale
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(false)
    expect(bus.state.internal.routes.find((r) => r.name === 'service-y')?.isStale).toBe(true)

    // Dispatch End-of-RIB for B
    const eorAction: Action = {
      action: Actions.InternalProtocolEndOfRib,
      data: { peerInfo: peerB },
    }
    await bus.dispatch(eorAction)

    // route-x exists (fresh), route-y is purged
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')).toBeDefined()
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(false)
    expect(bus.state.internal.routes.find((r) => r.name === 'service-y')).toBeUndefined()
  })

  it('EoR with no stale routes is a no-op', async () => {
    const peerB = makePeer('node-b')
    await connectPeer(bus, peerB)

    // B advertises route-x (fresh, no stale routes)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    const routeBefore = bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(routeBefore?.isStale).toBe(false)

    // Dispatch End-of-RIB — nothing stale, should be no-op
    const eorAction: Action = {
      action: Actions.InternalProtocolEndOfRib,
      data: { peerInfo: peerB },
    }
    const result = await bus.dispatch(eorAction)

    // No state change
    expect(result.success).toBe(false)
    // Route still exists unchanged
    expect(bus.state.internal.routes.find((r) => r.name === 'service-x')).toBeDefined()
  })

  it('EoR withdrawal is propagated to other connected peers', async () => {
    const peerB = makePeer('node-b')
    const peerC = makePeer('node-c')
    await connectPeer(bus, peerB)
    await connectPeer(bus, peerC)

    // B advertises route-x and route-y
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            { action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' },
            { action: 'add', route: routeY, nodePath: ['node-b'], originNode: 'node-b' },
          ],
        },
      },
    })

    // Transport error on B
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })

    // B reconnects, re-advertises only route-x
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    transport.reset()

    // Dispatch End-of-RIB for B — route-y should be purged and withdrawal sent to C
    const eorAction: Action = {
      action: Actions.InternalProtocolEndOfRib,
      data: { peerInfo: peerB },
    }
    await bus.dispatch(eorAction)

    // Withdrawal of route-y must have been sent to node-c
    const updateCalls = transport
      .getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    const removals = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate'
        ? c.message.updates.filter((u) => u.action === 'remove' && u.route.name === 'service-y')
        : []
    )
    expect(removals.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: InternalProtocolConnected auto-dispatches EoR after sync
// ---------------------------------------------------------------------------

describe('Graceful restart: InternalProtocolConnected auto-dispatches EoR', () => {
  const routeY = { name: 'service-y', protocol: 'http' as const, endpoint: 'http://svc-y:8080' }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reconnect auto-purges stale routes that were not re-advertised during sync', async () => {
    const BASE_NOW = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW)

    const transport = new MockPeerTransport()
    const busA = new OrchestratorBus({ config: makeConfig('node-a'), transport })
    const peerB = makePeer('node-b')

    // Connect B, B advertises route-x and route-y
    await connectPeer(busA, peerB)
    await busA.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            { action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' },
            { action: 'add', route: routeY, nodePath: ['node-b'], originNode: 'node-b' },
          ],
        },
      },
    })

    expect(busA.state.internal.routes).toHaveLength(2)

    // B disconnects with transport error (consecutiveFailures becomes 1)
    await busA.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: peerB, code: CloseCodes.TRANSPORT_ERROR },
    })
    expect(busA.state.internal.routes.every((r) => r.isStale === true)).toBe(true)

    // B reconnects — advance time far enough for B's refresh before
    // InternalProtocolConnected, then use an incrementing clock so that
    // by the time handleBGPNotify checks syncDeferredUntil, Date.now()
    // has advanced past it. planInternalProtocolConnected computes
    // syncDeferredUntil = now + 5000 (base delay for 1 failure), so we
    // need Date.now() to return > T+5000 during the post-commit phase.
    const reconnectTime = BASE_NOW + 10_000
    vi.spyOn(Date, 'now').mockReturnValue(reconnectTime)

    await busA.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

    // B sends its refreshed route before InternalProtocolConnected
    await busA.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [{ action: 'add', route: routeX, nodePath: ['node-b'], originNode: 'node-b' }],
        },
      },
    })

    // Use an incrementing clock: the plan phase of InternalProtocolConnected
    // uses Date.now() once to set syncDeferredUntil = T + 5000. The post-commit
    // handleBGPNotify also calls Date.now() once to check the deferral. By
    // returning a later time on the second call, the sync proceeds and EoR fires.
    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++
      // Call 1 (plan phase): sets syncDeferredUntil = reconnectTime + 5000
      // Call 2+ (post-commit): returns past syncDeferredUntil so sync fires
      return callCount <= 1 ? reconnectTime : reconnectTime + 10_000
    })

    // InternalProtocolConnected triggers auto-EoR dispatch (queued, not awaited).
    await busA.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: peerB },
    })

    // Allow the queued EoR dispatch to execute (it runs on the next microtask
    // after the ActionQueue drains the InternalProtocolConnected dispatch)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // route-x should be fresh, route-y should be purged by auto-EoR
    expect(busA.state.internal.routes.find((r) => r.name === 'service-x')).toBeDefined()
    expect(busA.state.internal.routes.find((r) => r.name === 'service-x')?.isStale).toBe(false)
    expect(busA.state.internal.routes.find((r) => r.name === 'service-y')).toBeUndefined()
  })
})
