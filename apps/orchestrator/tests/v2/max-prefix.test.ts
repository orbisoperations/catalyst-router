import { describe, it, expect } from 'vitest'
import { RoutingInformationBase, Actions, newRouteTable } from '@catalyst/routing/v2'
import type { RouteTable, PeerRecord, PeerInfo, Action } from '@catalyst/routing/v2'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../src/v2/transport.js'
import type { OrchestratorConfig } from '../../src/v1/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nodeId = 'node-a'
const peerB: PeerInfo = { name: 'node-b', endpoint: 'ws://b:4000', domains: ['test.local'] }

function makeRoute(name: string) {
  return { name, protocol: 'http' as const, endpoint: `http://${name}:8080` }
}

function stateWithPeer(maxPrefixes?: number): RouteTable {
  const state = newRouteTable()
  const peer: PeerRecord = {
    ...peerB,
    connectionStatus: 'connected',
    lastConnected: 1000,
    holdTime: 90_000,
    lastSent: 0,
    lastReceived: 1000,
    maxPrefixes,
  }
  state.internal.peers = [peer]
  return state
}

function makeUpdate(names: string[], actionType: 'add' | 'remove' = 'add'): Action {
  return {
    action: Actions.InternalProtocolUpdate,
    data: {
      peerInfo: peerB,
      update: {
        updates: names.map((name) => ({
          action: actionType,
          route: makeRoute(name),
          nodePath: ['node-b'],
          originNode: 'node-b',
        })),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('max prefix limits (drop-excess model)', () => {
  it('accepts routes up to exactly the limit', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(3)
    const action = makeUpdate(['svc-1', 'svc-2', 'svc-3'])

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(3)
    expect(plan.newState.internal.routes).toHaveLength(3)
  })

  it('drops excess routes individually', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(3)
    const action = makeUpdate(['svc-1', 'svc-2', 'svc-3', 'svc-4', 'svc-5'])

    const plan = rib.plan(action, state)

    const added = plan.routeChanges.filter((c) => c.type === 'added')
    expect(added).toHaveLength(3)
    expect(added.map((c) => c.route.name)).toEqual(['svc-1', 'svc-2', 'svc-3'])
    expect(plan.newState.internal.routes).toHaveLength(3)
  })

  it('remove below limit then add more succeeds', () => {
    const rib = new RoutingInformationBase({ nodeId })

    // Fill to limit of 3
    const state = stateWithPeer(3)
    const fillAction = makeUpdate(['svc-1', 'svc-2', 'svc-3'])
    const fillPlan = rib.plan(fillAction, state)
    rib.commit(fillPlan, fillAction)

    // Remove one route
    const removeAction = makeUpdate(['svc-2'], 'remove')
    const removePlan = rib.plan(removeAction, rib.state)
    rib.commit(removePlan, removeAction)

    expect(rib.state.internal.routes).toHaveLength(2)

    // Add two new routes — only 1 should be accepted (back to limit of 3)
    const addAction = makeUpdate(['svc-4', 'svc-5'])
    const addPlan = rib.plan(addAction, rib.state)

    const added = addPlan.routeChanges.filter((c) => c.type === 'added')
    expect(added).toHaveLength(1)
    expect(added[0].route.name).toBe('svc-4')
  })

  it('maxPrefixes: 0 means unlimited', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(0)
    const names = Array.from({ length: 100 }, (_, i) => `svc-${i}`)
    const action = makeUpdate(names)

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(100)
    expect(plan.newState.internal.routes).toHaveLength(100)
  })

  it('peer with no maxPrefixes set works unchanged', () => {
    const rib = new RoutingInformationBase({ nodeId })
    const state = stateWithPeer(undefined)
    const names = Array.from({ length: 50 }, (_, i) => `svc-${i}`)
    const action = makeUpdate(names)

    const plan = rib.plan(action, state)

    expect(plan.routeChanges.filter((c) => c.type === 'added')).toHaveLength(50)
    expect(plan.newState.internal.routes).toHaveLength(50)
  })

  it('count is per-peer', () => {
    const rib = new RoutingInformationBase({ nodeId })

    const peerC: PeerInfo = { name: 'node-c', endpoint: 'ws://c:4000', domains: ['test.local'] }

    const state = newRouteTable()
    const peerBRecord: PeerRecord = {
      ...peerB,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    }
    const peerCRecord: PeerRecord = {
      ...peerC,
      connectionStatus: 'connected',
      lastConnected: 1000,
      holdTime: 90_000,
      lastSent: 0,
      lastReceived: 1000,
      maxPrefixes: 2,
    }
    state.internal.peers = [peerBRecord, peerCRecord]

    // Fill peer B: send 3, expect 2 accepted
    const fillB = makeUpdate(['svc-1', 'svc-2', 'svc-3'])
    const planB = rib.plan(fillB, state)
    rib.commit(planB, fillB)

    const addedB = planB.routeChanges.filter((c) => c.type === 'added')
    expect(addedB).toHaveLength(2)

    // Peer C should still be able to add routes
    const fillC: Action = {
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerC,
        update: {
          updates: [
            {
              action: 'add' as const,
              route: makeRoute('svc-from-c'),
              nodePath: ['node-c'],
              originNode: 'node-c',
            },
          ],
        },
      },
    }
    const planC = rib.plan(fillC, rib.state)

    const addedC = planC.routeChanges.filter((c) => c.type === 'added')
    expect(addedC).toHaveLength(1)
    expect(addedC[0].route.name).toBe('svc-from-c')
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
// Topology tests for max prefix limits
// ---------------------------------------------------------------------------

describe('Topology: max prefix limits', () => {
  it('drop-excess propagation: A→B (limit=5) →C, only 5 routes reach C', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')
    topo.addNode('node-c')

    // Wire A↔B manually so B has maxPrefixes=5 for A
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 5 },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })

    // Wire B↔C with normal peering (no limit)
    await topo.peer('node-b', 'node-c')
    topo.resetAll()

    // A creates 7 local routes
    for (let i = 1; i <= 7; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: makeRoute(`svc-${i}`),
      })
    }

    // Propagate A→B: B should accept only 5
    await topo.propagate('node-a', 'node-b')

    const bRoutes = topo.get('node-b').bus.state.internal.routes
    const bFromA = bRoutes.filter((r) => r.peer.name === 'node-a')
    expect(bFromA).toHaveLength(5)

    // Propagate B→C: C should receive exactly the 5 routes B accepted
    await topo.propagate('node-b', 'node-c')

    const cRoutes = topo.get('node-c').bus.state.internal.routes
    expect(cRoutes).toHaveLength(5)
  })

  it('session stays alive after hitting limit: B still shows A as connected', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')

    // Wire A↔B with B having maxPrefixes=2 for A
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 2 },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })
    topo.resetAll()

    // A creates 5 routes
    for (let i = 1; i <= 5; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: makeRoute(`svc-${i}`),
      })
    }

    // Propagate A→B: B accepts only 2
    await topo.propagate('node-a', 'node-b')

    const bRoutes = topo.get('node-b').bus.state.internal.routes
    expect(bRoutes.filter((r) => r.peer.name === 'node-a')).toHaveLength(2)

    // Peer session must remain connected (drop-excess, not session-teardown)
    const peerA = topo.get('node-b').bus.state.internal.peers.find((p) => p.name === 'node-a')
    expect(peerA).toBeDefined()
    expect(peerA!.connectionStatus).toBe('connected')
  })

  it('remove-then-add respects updated count', async () => {
    const topo = new TopologyHelper()
    topo.addNode('node-a')
    topo.addNode('node-b')

    // Wire A↔B with B having maxPrefixes=3 for A
    await topo.get('node-b').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: { ...topo.get('node-a').peerInfo, maxPrefixes: 3 },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalPeerCreate,
      data: topo.get('node-b').peerInfo,
    })
    await topo.get('node-b').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-b').peerInfo },
    })
    topo.resetAll()

    // Phase 1: A creates 3 routes, fill to limit
    for (let i = 1; i <= 3; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: makeRoute(`svc-${i}`),
      })
    }
    await topo.propagate('node-a', 'node-b')

    const bRoutesPhase1 = topo.get('node-b').bus.state.internal.routes
    expect(bRoutesPhase1.filter((r) => r.peer.name === 'node-a')).toHaveLength(3)
    topo.resetAll()

    // Phase 2: A removes 2 routes, B should drop to 1
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: makeRoute('svc-1'),
    })
    await topo.get('node-a').bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: makeRoute('svc-2'),
    })
    await topo.propagate('node-a', 'node-b')

    const bRoutesPhase2 = topo.get('node-b').bus.state.internal.routes
    expect(bRoutesPhase2.filter((r) => r.peer.name === 'node-a')).toHaveLength(1)
    topo.resetAll()

    // Phase 3: A creates 3 new routes — B should accept 2 more (back to limit of 3)
    for (let i = 4; i <= 6; i++) {
      await topo.get('node-a').bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: makeRoute(`svc-${i}`),
      })
    }
    await topo.propagate('node-a', 'node-b')

    const bRoutesPhase3 = topo.get('node-b').bus.state.internal.routes
    expect(bRoutesPhase3.filter((r) => r.peer.name === 'node-a')).toHaveLength(3)
  })
})
