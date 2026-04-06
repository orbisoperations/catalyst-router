import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RoutingInformationBase,
  Actions,
  newRouteTable,
  routeKey,
  FLAP_PENALTY_INCREMENT,
  FLAP_SUPPRESS_THRESHOLD,
  FLAP_HALF_LIFE_MS,
  FLAP_MAX_SUPPRESS_MS,
} from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo } from '@catalyst/routing/v2'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../src/v2/transport.js'
import type { OrchestratorConfig } from '../../src/v1/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }
const route1 = { name: 'svc-1', protocol: 'http' as const, endpoint: 'http://svc-1:8080' }
const route2 = { name: 'svc-2', protocol: 'http' as const, endpoint: 'http://svc-2:8080' }

function connectedState(): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
  }
  state.internal.peers = [peer]
  return state
}

function addAction(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'add' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

function removeAction(route: typeof route1) {
  return {
    action: Actions.InternalProtocolUpdate as const,
    data: {
      peerInfo: peerB,
      update: {
        updates: [{ action: 'remove' as const, route, nodePath: ['node-b'], originNode: 'node-b' }],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('route flap damping (RFC 7196 / RIPE-580)', () => {
  it('single withdraw/re-add below threshold — not suppressed', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Add route
    const a1 = addAction(route1)
    const p1 = rib.plan(a1, state)
    rib.commit(p1, a1)

    // Remove route
    const r1 = removeAction(route1)
    const p2 = rib.plan(r1, rib.state)
    rib.commit(p2, r1)

    // Re-add route
    const a2 = addAction(route1)
    const p3 = rib.plan(a2, rib.state)
    rib.commit(p3, a2)

    const fk = routeKey(route1) + ':node-b'
    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    // One remove (1000) + one add-after-remove (decayed ~1000 + 1000 ≈ 2000)
    expect(entry!.penalty).toBeGreaterThanOrEqual(FLAP_PENALTY_INCREMENT)
    expect(entry!.penalty).toBeLessThan(FLAP_SUPPRESS_THRESHOLD)
    expect(entry!.suppressed).toBe(false)
  })

  it('six rapid flaps exceed threshold — suppressed', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)

    const fk = routeKey(route1) + ':node-b'
    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(true)
    expect(entry!.penalty).toBeGreaterThanOrEqual(FLAP_SUPPRESS_THRESHOLD)
  })

  it('different routes from same peer damped independently', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 six times to suppress it
    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }
    // Final add for route1
    const finalAdd1 = addAction(route1)
    const fp1 = rib.plan(finalAdd1, currentState)
    rib.commit(fp1, finalAdd1)
    currentState = rib.state

    // Add route2 normally (no flapping)
    const add2 = addAction(route2)
    const ap2 = rib.plan(add2, currentState)
    rib.commit(ap2, add2)

    const fk1 = routeKey(route1) + ':node-b'
    const fk2 = routeKey(route2) + ':node-b'

    const entry1 = rib.flapState.get(fk1)
    expect(entry1).toBeDefined()
    expect(entry1!.suppressed).toBe(true)

    // route2 should have no flap entry (never withdrawn)
    const entry2 = rib.flapState.get(fk2)
    expect(entry2).toBeUndefined()
  })

  it('tick decays penalty — suppressed route becomes reusable after 4 half-lives', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 six times to suppress it
    let currentState = state
    for (let i = 0; i < 6; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)
    currentState = rib.state

    const fk = routeKey(route1) + ':node-b'
    expect(rib.flapState.get(fk)?.suppressed).toBe(true)

    // Dispatch Tick far enough in the future: penalty is ~12000 after 6 flap cycles.
    // 5 half-lives => 12000 * 0.5^5 = 375 < 750 reuse threshold.
    const tickAction = {
      action: Actions.Tick as const,
      data: { now: Date.now() + FLAP_HALF_LIFE_MS * 5 },
    }
    const tickPlan = rib.plan(tickAction, currentState)
    rib.commit(tickPlan, tickAction)

    const entry = rib.flapState.get(fk)
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(false)
  })

  it('max suppress time cap — unsuppressed after 30 minutes despite high penalty', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = connectedState()

    // Flap route1 twenty times to get very high penalty
    let currentState = state
    for (let i = 0; i < 20; i++) {
      const add = addAction(route1)
      const ap = rib.plan(add, currentState)
      rib.commit(ap, add)
      currentState = rib.state

      const rm = removeAction(route1)
      const rp = rib.plan(rm, currentState)
      rib.commit(rp, rm)
      currentState = rib.state
    }

    // Final add
    const finalAdd = addAction(route1)
    const fp = rib.plan(finalAdd, currentState)
    rib.commit(fp, finalAdd)
    currentState = rib.state

    const fk = routeKey(route1) + ':node-b'
    expect(rib.flapState.get(fk)?.suppressed).toBe(true)

    // Dispatch Tick just past the max suppress duration (30 min + 1 sec)
    const tickAction = {
      action: Actions.Tick as const,
      data: { now: Date.now() + FLAP_MAX_SUPPRESS_MS + 1000 },
    }
    const tickPlan = rib.plan(tickAction, currentState)
    rib.commit(tickPlan, tickAction)

    const entry = rib.flapState.get(fk)
    // Should be unsuppressed even though penalty may still be above reuse threshold
    expect(entry).toBeDefined()
    expect(entry!.suppressed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Topology helpers (copied from orchestrator.topology.test.ts)
// ---------------------------------------------------------------------------

function topoMakeConfig(name: string): OrchestratorConfig {
  return {
    node: { name, endpoint: `ws://${name}:4000`, domains: ['topo.local'] },
  }
}

function topoMakePeerInfo(name: string): PeerInfo {
  return {
    name,
    endpoint: `ws://${name}:4000`,
    domains: ['topo.local'],
    peerToken: `token-${name}`,
  }
}

function makeRoute(name: string) {
  return { name, protocol: 'http' as const, endpoint: `http://${name}:8080` }
}

interface BusEntry {
  name: string
  bus: OrchestratorBus
  transport: MockPeerTransport
  peerInfo: PeerInfo
}

class TopologyHelper {
  private nodes = new Map<string, BusEntry>()

  addNode(name: string): BusEntry {
    const transport = new MockPeerTransport()
    const config = topoMakeConfig(name)
    const bus = new OrchestratorBus({ config, transport })
    const entry: BusEntry = { name, bus, transport, peerInfo: topoMakePeerInfo(name) }
    this.nodes.set(name, entry)
    return entry
  }

  get(name: string): BusEntry {
    const entry = this.nodes.get(name)
    if (entry === undefined) throw new Error(`Unknown node: ${name}`)
    return entry
  }

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

  async propagate(fromName: string, toName: string): Promise<void> {
    const from = this.get(fromName)
    const to = this.get(toName)

    const consumed: TransportCall[] = []
    const remaining: TransportCall[] = []
    for (const call of from.transport.calls) {
      if (call.method === 'sendUpdate' && call.peer.name === toName) {
        consumed.push(call)
      } else {
        remaining.push(call)
      }
    }

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

  resetAll(): void {
    for (const entry of this.nodes.values()) {
      entry.transport.reset()
    }
  }
}

// ---------------------------------------------------------------------------
// Topology: flap damping multi-node tests
// ---------------------------------------------------------------------------

describe('Flap damping topology', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Helper: flap a route N times at a source node, propagating through the
   * chain after each add and remove. Each cycle is:
   *   1. source dispatches LocalRouteCreate
   *   2. propagate through the chain
   *   3. resetAll
   *   4. source dispatches LocalRouteDelete
   *   5. propagate through the chain
   *   6. resetAll
   */
  async function flapRoute(
    topo: TopologyHelper,
    sourceName: string,
    chain: string[],
    routeName: string,
    cycles: number
  ): Promise<void> {
    const route = makeRoute(routeName)
    for (let i = 0; i < cycles; i++) {
      await topo.get(sourceName).bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
      for (const [idx, from] of chain.entries()) {
        const to = chain[idx + 1]
        if (to !== undefined) await topo.propagate(from, to)
      }
      topo.resetAll()

      await topo.get(sourceName).bus.dispatch({ action: Actions.LocalRouteDelete, data: route })
      for (const [idx, from] of chain.entries()) {
        const to = chain[idx + 1]
        if (to !== undefined) await topo.propagate(from, to)
      }
      topo.resetAll()
    }
  }

  it('A flaps route 6 times — B suppresses propagation to C', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    // Flap 'flappy' 6 times through A→B→C
    await flapRoute(topo, 'node-a', ['node-a', 'node-b', 'node-c'], 'flappy', 6)

    // Final add: A creates the route one last time
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('flappy'),
    })
    await topo.propagate('node-a', 'node-b')

    // B should have 'flappy' in its internal routes (the route was accepted)
    const bRoutes = topo.get('node-b').bus.state.internal.routes
    expect(bRoutes.some((r) => r.name === 'flappy')).toBe(true)

    // B's transport should have NO sendUpdate calls to C containing 'flappy' as an 'add'
    // because B suppresses propagation of the flapping route
    const callsToC = topo
      .get('node-b')
      .transport.calls.filter((c) => c.method === 'sendUpdate' && c.peer.name === 'node-c')

    const addUpdatesForFlappy = callsToC.flatMap((c) =>
      c.method === 'sendUpdate'
        ? c.message.updates.filter(
            (u: { action: string; route: { name: string } }) =>
              u.action === 'add' && u.route.name === 'flappy'
          )
        : []
    )
    expect(addUpdatesForFlappy).toHaveLength(0)
  })

  it('after decay, B resumes propagating to C', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    await topo.peer('node-a', 'node-b')
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    // Flap 'flappy' 6 times, then final add — route is suppressed at B
    await flapRoute(topo, 'node-a', ['node-a', 'node-b', 'node-c'], 'flappy', 6)
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('flappy'),
    })
    await topo.propagate('node-a', 'node-b')

    // Verify suppressed at B
    const fk = 'flappy:node-a'
    expect(topo.get('node-b').bus.rib.flapState.get(fk)?.suppressed).toBe(true)
    topo.resetAll()

    // Advance time by 5 half-lives (25 minutes) — penalty decays well below reuse threshold.
    // After 6 flap cycles + final add, penalty ~13000. 13000 * 0.5^5 = 406.25 < 750 reuse.
    vi.setSystemTime(Date.now() + FLAP_HALF_LIFE_MS * 5)

    // Keep peers alive: dispatch keepalives so hold timers don't expire
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: topo.get('node-c').peerInfo },
    })
    topo.resetAll()

    // Dispatch Tick on B to trigger flap decay
    await topo.get('node-b').bus.dispatch({
      action: Actions.Tick,
      data: { now: Date.now() },
    })

    // Verify unsuppressed
    expect(topo.get('node-b').bus.rib.flapState.get(fk)?.suppressed ?? false).toBe(false)
    topo.resetAll()

    // Trigger a route change at B so it can propagate to C.
    // Remove and re-add the route from A. The penalty from this single cycle
    // is small relative to the decayed value, so it stays unsuppressed.
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: makeRoute('flappy'),
    })
    await topo.propagate('node-a', 'node-b')
    topo.resetAll()

    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('flappy'),
    })
    await topo.propagate('node-a', 'node-b')
    await topo.propagate('node-b', 'node-c')

    // C should now have 'flappy' in its internal routes
    const cRoutes = topo.get('node-c').bus.state.internal.routes
    expect(cRoutes.some((r) => r.name === 'flappy')).toBe(true)
  })

  it('suppressed route loses best-path to fresh route from another peer', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-c')
    topo.addNode('node-d')

    // Wire A↔C and D↔C
    await topo.peer('node-a', 'node-c')
    await topo.peer('node-d', 'node-c')
    topo.resetAll()

    // Flap route 'contested' from A at C 6 times
    await flapRoute(topo, 'node-a', ['node-a', 'node-c'], 'contested', 6)

    // Final add from A, propagate A→C — route is suppressed at C
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('contested'),
    })
    await topo.propagate('node-a', 'node-c')

    const fk = 'contested:node-a'
    expect(topo.get('node-c').bus.rib.flapState.get(fk)?.suppressed).toBe(true)
    topo.resetAll()

    // D creates route 'contested' normally (no flap), propagate D→C
    await topo.get('node-d').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('contested'),
    })
    await topo.propagate('node-d', 'node-c')

    // C should have 'contested' from D (originNode='node-d')
    const cRoutes = topo.get('node-c').bus.state.internal.routes
    const contestedRoute = cRoutes.find((r) => r.name === 'contested' && r.originNode === 'node-d')
    expect(contestedRoute).toBeDefined()
  })

  it('independent damping — flappy suppressed, stable propagates', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')

    await topo.peer('node-a', 'node-b')
    topo.resetAll()

    // Flap route 'flappy' from A at B 6 times, then final add
    await flapRoute(topo, 'node-a', ['node-a', 'node-b'], 'flappy', 6)
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('flappy'),
    })
    await topo.propagate('node-a', 'node-b')
    topo.resetAll()

    // Also add route 'stable' from A normally
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: makeRoute('stable'),
    })
    await topo.propagate('node-a', 'node-b')

    // B should have both routes in internal routes
    const bRoutes = topo.get('node-b').bus.state.internal.routes
    expect(bRoutes.some((r) => r.name === 'flappy')).toBe(true)
    expect(bRoutes.some((r) => r.name === 'stable')).toBe(true)

    // Check B's RIB flapState
    const rib = topo.get('node-b').bus.rib
    const flappyEntry = rib.flapState.get('flappy:node-a')
    expect(flappyEntry).toBeDefined()
    expect(flappyEntry!.suppressed).toBe(true)

    // 'stable' was never withdrawn, so it has no flapState entry
    const stableEntry = rib.flapState.get('stable:node-a')
    expect(stableEntry).toBeUndefined()
  })
})
