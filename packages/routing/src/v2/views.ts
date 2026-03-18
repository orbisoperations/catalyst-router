import type { DataChannelDefinition } from './datachannel.js'
import type { PeerRecord, InternalRoute, RouteTable } from './state.js'

/** Public peer shape — credentials and internal bookkeeping stripped. */
export type PublicPeer = Omit<PeerRecord, 'peerToken' | 'holdTime' | 'lastSent' | 'lastReceived'>

/** Public internal route shape — credentials and internal flags stripped. */
export type PublicInternalRoute = Omit<InternalRoute, 'isStale'> & {
  peer: Omit<InternalRoute['peer'], 'peerToken'>
}

/** Public route table — safe for API exposure. */
export type PublicRouteTable = {
  routes: {
    local: DataChannelDefinition[]
    internal: PublicInternalRoute[]
  }
  peers: PublicPeer[]
}

/** Wraps a PeerRecord for safe API exposure. */
export class PeerView {
  constructor(private readonly data: PeerRecord) {}

  get name(): string {
    return this.data.name
  }

  /** Returns peer data safe for API exposure (credentials + bookkeeping stripped). */
  toPublic(): PublicPeer {
    const {
      peerToken: _token,
      holdTime: _hold,
      lastSent: _sent,
      lastReceived: _recv,
      ...rest
    } = this.data
    return rest
  }
}

/** Wraps an InternalRoute for safe API exposure and transport transforms. */
export class InternalRouteView {
  constructor(private readonly data: InternalRoute) {}

  get name(): string {
    return this.data.name
  }

  /** Returns route safe for API exposure (peer credentials + isStale stripped). */
  toPublic(): PublicInternalRoute {
    const { peerToken: _, ...safePeer } = this.data.peer
    const { isStale: _stale, ...rest } = this.data
    return { ...rest, peer: safePeer }
  }

  /** Returns only DataChannelDefinition fields (strips peer, nodePath, originNode, isStale). */
  toDataChannel(): DataChannelDefinition {
    return {
      name: this.data.name,
      protocol: this.data.protocol,
      endpoint: this.data.endpoint,
      region: this.data.region,
      tags: this.data.tags,
      envoyPort: this.data.envoyPort,
      healthStatus: this.data.healthStatus,
      responseTimeMs: this.data.responseTimeMs,
      lastChecked: this.data.lastChecked,
    }
  }
}

/** Wraps a RouteTable for safe API exposure. */
export class RouteTableView {
  constructor(private readonly state: RouteTable) {}

  /** Returns the full route table safe for API exposure. */
  toPublic(): PublicRouteTable {
    return {
      routes: {
        local: this.state.local.routes,
        internal: this.state.internal.routes.map((r) => new InternalRouteView(r).toPublic()),
      },
      peers: this.state.internal.peers.map((p) => new PeerView(p).toPublic()),
    }
  }
}
