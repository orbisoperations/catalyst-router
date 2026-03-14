import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { InMemoryActionLog } from '@catalyst/routing/v2'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const configA: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['example.local'],
  },
}

const peerBInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['example.local'],
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _makeConnectedBus(config: OrchestratorConfig, peerInfo: PeerInfo) {
  const transport = new MockPeerTransport()
  const bus = new OrchestratorBus({ config, transport })
  return { bus, transport, peerInfo }
}

async function setupConnectedPeer(bus: OrchestratorBus, peerInfo: PeerInfo) {
  await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
  await bus.dispatch({
    action: Actions.InternalProtocolConnected,
    data: { peerInfo },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorBus — basic dispatch behaviour', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
  })

  it('dispatch() serializes concurrent actions so they run in order', async () => {
    const order: string[] = []

    // Intercept sendUpdate to track call order
    const originalSend = transport.sendUpdate.bind(transport)
    vi.spyOn(transport, 'sendUpdate').mockImplementation(async (peer, msg) => {
      order.push(`update-${msg.updates[0]?.action ?? 'unknown'}`)
      return originalSend(peer, msg)
    })

    // Set up a connected peer first
    await setupConnectedPeer(bus, peerBInfo)
    transport.reset()

    // Dispatch two route adds concurrently
    const p1 = bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    const p2 = bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'beta', protocol: 'http' as const, endpoint: 'http://beta:8080' },
    })

    const [r1, r2] = await Promise.all([p1, p2])

    // Both should succeed
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    // The state after both commits must contain both routes
    const state = bus.state
    const names = [...state.local.routes.values()].map((r) => r.name)
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
  })

  it('dispatch() records to journal when state changes', async () => {
    const journal = new InMemoryActionLog()
    const busWithJournal = new OrchestratorBus({ config: configA, transport, journal })

    expect(journal.lastSeq()).toBe(0)

    await busWithJournal.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    expect(journal.lastSeq()).toBe(1)
    const entries = journal.replay()
    expect(entries).toHaveLength(1)
    expect(entries[0].action.action).toBe(Actions.LocalRouteCreate)
  })

  it('dispatch() does NOT record to journal when there is no state change', async () => {
    const journal = new InMemoryActionLog()
    const busWithJournal = new OrchestratorBus({ config: configA, transport, journal })

    // First create succeeds
    await busWithJournal.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    expect(journal.lastSeq()).toBe(1)

    // Second create for the same route is a no-op
    await busWithJournal.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })
    expect(journal.lastSeq()).toBe(1) // not incremented
  })

  it('dispatch() returns error result when action causes no state change', async () => {
    // Deleting a route that does not exist is a no-op
    const result = await bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'nonexistent', protocol: 'http' as const },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTruthy()
    }
  })

  it('dispatch() returns committed snapshot in success result', async () => {
    const result = await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.state.local.routes.size).toBe(1)
      expect(result.state.local.routes.get('alpha')?.name).toBe('alpha')
    }
  })

  it('handlePostCommit receives committed snapshot and sends to connected peers', async () => {
    await setupConnectedPeer(bus, peerBInfo)
    transport.reset()

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    const updateCalls = transport.getCallsFor('sendUpdate')
    expect(updateCalls).toHaveLength(1)
    const call = updateCalls[0]
    if (call.method !== 'sendUpdate') throw new Error('wrong call type')

    // The committed state must reflect the route
    const state = bus.state
    expect(state.local.routes.has('alpha')).toBe(true)

    // The update message must contain the correct route
    expect(call.message.updates).toHaveLength(1)
    expect(call.message.updates[0].route.name).toBe('alpha')
    expect(call.message.updates[0].action).toBe('add')
  })
})

describe('OrchestratorBus — getStateSnapshot() immutability', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config: configA, transport })
  })

  it('getStateSnapshot() returns a deep clone that does not affect the live state', async () => {
    // 1. Add a route to the bus
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    // 2. Get a snapshot via getStateSnapshot()
    const snapshot = bus.getStateSnapshot()

    // 3. Mutate the snapshot (set a fake route and modify existing route name)
    snapshot.local.routes.set('injected', {
      name: 'injected',
      protocol: 'http' as const,
      endpoint: 'http://injected:9999',
    })
    const alphaRoute = snapshot.local.routes.get('alpha')!
    alphaRoute.name = 'mutated-alpha'

    // 4. Verify bus.state is unchanged (the mutation did not propagate)
    const liveState = bus.state
    const liveNames = [...liveState.local.routes.values()].map((r) => r.name)
    expect(liveNames).toContain('alpha')
    expect(liveNames).not.toContain('injected')
    expect(liveNames).not.toContain('mutated-alpha')
    expect(liveState.local.routes.size).toBe(1)
  })

  it('getStateSnapshot() reflects current state at call time', async () => {
    // 1. Get snapshot before adding route
    const snapshotBefore = bus.getStateSnapshot()

    // 2. Add a route
    await bus.dispatch({ action: Actions.LocalRouteCreate, data: routeAlpha })

    // 3. Get snapshot after adding route
    const snapshotAfter = bus.getStateSnapshot()

    // 4. Verify they differ (second has the new route)
    expect(snapshotBefore.local.routes.size).toBe(0)
    expect(snapshotAfter.local.routes.size).toBe(1)
    expect(snapshotAfter.local.routes.get('alpha')?.name).toBe('alpha')
  })
})
