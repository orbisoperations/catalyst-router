/**
 * Topology tests for Loc-RIB cross-peer best-path selection.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../src/v2/transport.js'
import { Actions, CloseCodes } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

function makeConfig(name: string): OrchestratorConfig {
  return { node: { name, endpoint: `ws://${name}:4000`, domains: ['topo.local'] } }
}

function makePeerInfo(name: string): PeerInfo {
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
    for (const c of remaining) from.transport.calls.push(c)
    for (const call of consumed) {
      if (call.method !== 'sendUpdate') continue
      await to.bus.dispatch({
        action: Actions.InternalProtocolUpdate,
        data: { peerInfo: from.peerInfo, update: call.message },
      })
    }
  }

  resetAll(): void {
    for (const entry of this.nodes.values()) entry.transport.reset()
  }
}

const routeX = { name: 'service-x', protocol: 'http' as const, endpoint: 'http://svc-x:8080' }

describe('Loc-RIB topology: triangle A↔B, A↔C, B↔C', () => {
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

  it('picks shorter path when same route arrives via two peers', async () => {
    // C creates a local route
    await topo.get('node-c').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    // C→B (B generates a forwarding update for its peers including A)
    await topo.propagate('node-c', 'node-b')
    // B→A (2-hop via B)
    await topo.propagate('node-b', 'node-a')
    // C→A direct (1-hop) — arrives after the 2-hop path
    await topo.propagate('node-c', 'node-a')

    // A should pick node-c as best (direct 1-hop beats 2-hop via B)
    const stateA = topo.get('node-a').bus.state
    expect(stateA.internal.locRib.get('service-x:node-c')).toBe('node-c')
  })

  it('falls back to longer path when direct peer disconnects', async () => {
    await topo.get('node-c').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    // Establish both paths to A: C→B→A (2-hop) and C→A (1-hop)
    await topo.propagate('node-c', 'node-b')
    await topo.propagate('node-b', 'node-a')
    await topo.propagate('node-c', 'node-a')
    topo.resetAll()

    // Kill the direct C↔A link
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: topo.get('node-c').peerInfo, code: CloseCodes.NORMAL },
    })

    // A should fall back to the 2-hop path via node-b
    const stateA = topo.get('node-a').bus.state
    expect(stateA.internal.locRib.get('service-x:node-c')).toBe('node-b')
  })

  it('reconverges when better path reappears', async () => {
    await topo.get('node-c').bus.dispatch({ action: Actions.LocalRouteCreate, data: routeX })

    // Establish both paths to A: C→B→A (2-hop) and C→A (1-hop)
    await topo.propagate('node-c', 'node-b')
    await topo.propagate('node-b', 'node-a')
    await topo.propagate('node-c', 'node-a')
    topo.resetAll()

    // Kill direct link
    await topo.get('node-a').bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo: topo.get('node-c').peerInfo, code: CloseCodes.NORMAL },
    })
    expect(topo.get('node-a').bus.state.internal.locRib.get('service-x:node-c')).toBe('node-b')

    // Reconnect: C fires InternalProtocolConnected for A, which triggers C to sync
    // its local routes to A as an initial full-table dump.
    await topo.get('node-c').bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo: topo.get('node-a').peerInfo },
    })
    // Deliver C's sync to A (generated during the InternalProtocolConnected dispatch above)
    await topo.propagate('node-c', 'node-a')

    // A should switch back to direct path
    expect(topo.get('node-a').bus.state.internal.locRib.get('service-x:node-c')).toBe('node-c')
  })
})
