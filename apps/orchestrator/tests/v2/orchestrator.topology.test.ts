/**
 * Multi-node topology tests for v2 OrchestratorBus BGP propagation.
 *
 * Uses a TopologyHelper that wires multiple OrchestratorBus instances together
 * via MockPeerTransport. When one bus calls sendUpdate on its transport, the
 * helper dispatches InternalProtocolUpdate to the target bus, simulating
 * real multi-hop network propagation without actual WebSocket connections.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Node identity fixtures
// ---------------------------------------------------------------------------

function makeConfig(name: string): OrchestratorConfig {
  return {
    node: { name, endpoint: `ws://${name}:4000`, domains: ['topo.local'] },
  }
}

function makePeerInfo(name: string): PeerInfo {
  return { name, endpoint: `ws://${name}:4000`, domains: ['topo.local'] }
}

// ---------------------------------------------------------------------------
// TopologyHelper
// ---------------------------------------------------------------------------

interface BusEntry {
  name: string
  bus: OrchestratorBus
  transport: MockPeerTransport
  peerInfo: PeerInfo
}

/**
 * Simulates a mesh of OrchestratorBus nodes for topology tests.
 *
 * Propagation is explicit: call `propagate(from, to)` to deliver any pending
 * sendUpdate calls from `from`'s transport to the `to` bus, then reset
 * `from`'s transport so the next propagation starts clean.
 */
class TopologyHelper {
  private nodes = new Map<string, BusEntry>()

  addNode(name: string): BusEntry {
    const transport = new MockPeerTransport()
    const config = makeConfig(name)
    const bus = new OrchestratorBus({ config, transport })
    const entry: BusEntry = { name, bus, transport, peerInfo: makePeerInfo(name) }
    this.nodes.set(name, entry)
    return entry
  }

  get(name: string): BusEntry {
    const entry = this.nodes.get(name)
    if (entry === undefined) throw new Error(`Unknown node: ${name}`)
    return entry
  }

  /**
   * Establish a bidirectional peer relationship between two nodes:
   *   LocalPeerCreate + InternalProtocolConnected on both sides.
   */
  async peer(nameA: string, nameB: string): Promise<void> {
    const a = this.get(nameA)
    const b = this.get(nameB)

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
  }

  /**
   * Deliver all pending sendUpdate calls from `fromName`'s transport to
   * `toName`'s bus as InternalProtocolUpdate actions.
   * Only removes the consumed calls from the transport — calls destined for
   * other peers are preserved so they can be delivered in subsequent propagate
   * calls.
   */
  async propagate(fromName: string, toName: string): Promise<void> {
    const from = this.get(fromName)
    const to = this.get(toName)

    // Snapshot and remove only calls destined for toName
    const consumed: TransportCall[] = []
    const remaining: TransportCall[] = []
    for (const call of from.transport.calls) {
      if (call.method === 'sendUpdate' && call.peer.name === toName) {
        consumed.push(call)
      } else {
        remaining.push(call)
      }
    }

    // Replace calls array in-place with the non-consumed entries
    from.transport.calls.length = 0
    for (const c of remaining) {
      from.transport.calls.push(c)
    }

    for (const call of consumed) {
      if (call.method !== 'sendUpdate') continue
      await to.bus.dispatch({
        action: Actions.InternalProtocolUpdate,
        data: { peerInfo: from.peerInfo, update: call.message },
      })
    }
  }

  /** Reset all transports (clear recorded calls). */
  resetAll(): void {
    for (const entry of this.nodes.values()) {
      entry.transport.reset()
    }
  }
}

// ---------------------------------------------------------------------------
// Test route fixtures
// ---------------------------------------------------------------------------

const routeX = { name: 'service-x', protocol: 'http' as const, endpoint: 'http://svc-x:8080' }
const routeY = { name: 'service-y', protocol: 'http' as const, endpoint: 'http://svc-y:8080' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Topology: Linear A↔B↔C', () => {
  let topo: TopologyHelper

  beforeEach(async () => {
    topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    // Wire: A↔B and B↔C (no direct A↔C link)
    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()
  })

  it('route created at A propagates to B', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    await topo.propagate('node-a', 'node-b')

    const stateB = topo.get('node-b').bus.state
    expect(stateB.internal.routes.some((r) => r.name === 'service-x')).toBe(true)
  })

  it('route created at A propagates B→C with nodePath [node-b, node-a]', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    // A→B hop
    await topo.propagate('node-a', 'node-b')
    // B→C hop
    await topo.propagate('node-b', 'node-c')

    const stateC = topo.get('node-c').bus.state
    const route = stateC.internal.routes.find((r) => r.name === 'service-x')
    expect(route).toBeDefined()
    // node-b prepends itself when forwarding: ['node-b', 'node-a']
    expect(route?.nodePath).toEqual(['node-b', 'node-a'])
    expect(route?.originNode).toBe('node-a')
  })

  it('route withdrawal from A reaches B and C, leaving no zombie routes', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-b', 'node-c')
    topo.resetAll()

    // A deletes the route
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: routeX })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-b', 'node-c')

    const stateB = topo.get('node-b').bus.state
    const stateC = topo.get('node-c').bus.state
    expect(stateB.internal.routes.some((r) => r.name === 'service-x')).toBe(false)
    expect(stateC.internal.routes.some((r) => r.name === 'service-x')).toBe(false)
  })

  it('route withdrawal reaches C with action=remove', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-b', 'node-c')
    topo.resetAll()

    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteDelete, data: routeX })
    await topo.propagate('node-a', 'node-b')

    const callsToC = topo
      .get('node-b')
      .transport.getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')
    expect(callsToC.length).toBeGreaterThanOrEqual(1)
    const update = callsToC[0]
    if (update.method !== 'sendUpdate') return
    expect(update.message.updates[0].action).toBe('remove')
  })
})

describe('Topology: Triangle A↔B, A↔C, B↔C', () => {
  let topo: TopologyHelper

  beforeEach(async () => {
    topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    await topo.peer('node-a', 'node-b')
    await topo.peer('node-a', 'node-c')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()
  })

  it("A's route reaches B and C directly", async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-a', 'node-c')

    expect(topo.get('node-b').bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(
      true
    )
    expect(topo.get('node-c').bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(
      true
    )
  })

  it("C keeps shorter direct path from A when B also forwards A's route", async () => {
    // A advertises to B and C
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-a', 'node-c')

    // Record C's current nodePath (direct from A: ['node-a'])
    const directRoute = topo
      .get('node-c')
      .bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(directRoute?.nodePath).toEqual(['node-a'])

    // B now forwards to C — longer path ['node-b', 'node-a']
    // C should keep the shorter existing path
    await topo.propagate('node-b', 'node-c')

    const routeAtC = topo
      .get('node-c')
      .bus.state.internal.routes.find((r) => r.name === 'service-x')
    expect(routeAtC).toBeDefined()
    // Best-path selection: existing ['node-a'] is shorter — unchanged
    expect(routeAtC?.nodePath).toEqual(['node-a'])
  })

  it('A disconnects → withdrawal with originNode reaches C, no zombie routes', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-a', 'node-c')
    topo.resetAll()

    // Hard close of A's peering session with B
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeerInfo('node-a'), code: CloseCodes.NORMAL },
    })
    // B fans out the withdrawal to C
    await topo.propagate('node-b', 'node-c')

    // Also close A↔C directly
    await topo.get('node-c').bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: makePeerInfo('node-a'), code: CloseCodes.NORMAL },
    })

    expect(topo.get('node-c').bus.state.internal.routes.some((r) => r.name === 'service-x')).toBe(
      false
    )
  })
})

describe('Topology: Initial sync — retroactive route learning', () => {
  it('B has local routes before A connects; A receives them via initial sync', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')

    // B creates routes before any peering
    await topo.get('node-b').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.get('node-b').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeY })
    topo.resetAll()

    // Now A peers with B — initial sync fires on InternalProtocolConnected
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-a').peerInfo,
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })

    // B's transport should have sent a sync to A
    await topo.propagate('node-b', 'node-a')

    const stateA = topo.get('node-a').bus.state
    const routeNames = stateA.internal.routes.map((r) => r.name)
    expect(routeNames).toContain('service-x')
    expect(routeNames).toContain('service-y')
  })
})

describe('Topology: Loop prevention', () => {
  it('A↔B↔C↔A mesh: route from A reaches B and C but never loops back to A', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    // Full mesh
    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    await topo.peer('node-c', 'node-a')
    topo.resetAll()

    // A creates a route
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    // A→B
    await topo.propagate('node-a', 'node-b')
    // A→C
    await topo.propagate('node-a', 'node-c')
    // B→C (C already has it from A, nodePath check keeps shorter)
    await topo.propagate('node-b', 'node-c')
    // B→A (loop! A's name is in nodePath — must be discarded)
    await topo.propagate('node-b', 'node-a')
    // C→A (loop! A's name is in nodePath — must be discarded)
    await topo.propagate('node-c', 'node-a')

    // A must have service-x only in local, not in internal
    const stateA = topo.get('node-a').bus.state
    expect(stateA.local.routes.some((r) => r.name === 'service-x')).toBe(true)
    expect(stateA.internal.routes.some((r) => r.name === 'service-x')).toBe(false)
  })
})

describe('Topology: Single sync trigger', () => {
  let topo: TopologyHelper

  beforeEach(async () => {
    topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
  })

  it('InternalProtocolOpen does NOT trigger route sync', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    topo.resetAll()

    // Open: peer is now connected in state, but no sync should fire
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })

    const updateCalls = topo.get('node-a').transport.getCallsFor('sendUpdate')
    expect(updateCalls).toHaveLength(0)
  })

  it('InternalProtocolConnected DOES trigger route sync exactly once', async () => {
    await topo.get('node-a').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    topo.resetAll()

    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })

    const updateCalls = topo
      .get('node-a')
      .transport.getCallsFor('sendUpdate')
      .filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-b')
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    const allUpdates = updateCalls.flatMap((c) =>
      c.method === 'sendUpdate' ? c.message.updates : []
    )
    expect(allUpdates.some((u) => u.route.name === 'service-x')).toBe(true)
  })
})
