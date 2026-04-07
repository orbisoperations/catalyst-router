import { Actions } from '@catalyst/routing/v2'
import type { PeerInfo } from '@catalyst/routing/v2'
import { OrchestratorBus } from '../../../src/v2/bus.js'
import { MockPeerTransport, type TransportCall } from '../../../src/v2/transport.js'
import type { OrchestratorConfig } from '../../../src/v1/types.js'

// ---------------------------------------------------------------------------
// Node identity fixtures
// ---------------------------------------------------------------------------

export function makeConfig(name: string): OrchestratorConfig {
  return {
    node: { name, endpoint: `ws://${name}:4000`, domains: ['topo.local'] },
  }
}

export function makePeerInfo(name: string): PeerInfo {
  return {
    name,
    endpoint: `ws://${name}:4000`,
    domains: ['topo.local'],
    peerToken: `token-${name}`,
  }
}

// ---------------------------------------------------------------------------
// TopologyHelper
// ---------------------------------------------------------------------------

export interface BusEntry {
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
export class TopologyHelper {
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
   * Only removes the consumed calls from the transport -- calls destined for
   * other peers are preserved so they can be delivered in subsequent propagate
   * calls.
   */
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

  /** Reset all transports (clear recorded calls). */
  resetAll(): void {
    for (const entry of this.nodes.values()) {
      entry.transport.reset()
    }
  }
}
