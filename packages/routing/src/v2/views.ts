import type { z } from 'zod'
import { type DataChannelDefinition } from './datachannel.js'
import { PeerRecordSchema, type PeerRecord, type InternalRoute, type RouteTable } from './state.js'

// ---------------------------------------------------------------------------
// Public schemas & types — safe for API exposure
// ---------------------------------------------------------------------------

/** Public peer shape — credentials and internal bookkeeping stripped. */
export const PublicPeerSchema = PeerRecordSchema.omit({
  peerToken: true,
  holdTime: true,
  lastSent: true,
  lastReceived: true,
})
export type PublicPeer = z.infer<typeof PublicPeerSchema>

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

// ---------------------------------------------------------------------------
// Transform functions
// ---------------------------------------------------------------------------

/** Returns peer data safe for API exposure (credentials + bookkeeping stripped). */
export function toPublicPeer(peer: PeerRecord): PublicPeer {
  const { peerToken: _token, holdTime: _hold, lastSent: _sent, lastReceived: _recv, ...rest } = peer
  return rest
}

/** Returns route safe for API exposure (peer credentials + isStale stripped). */
export function toPublicInternalRoute(route: InternalRoute): PublicInternalRoute {
  const { peerToken: _, ...safePeer } = route.peer
  const { isStale: _stale, ...rest } = route
  return { ...rest, peer: safePeer }
}

/** Returns only DataChannelDefinition fields (strips peer, nodePath, originNode, isStale). */
export function toDataChannel(route: DataChannelDefinition | InternalRoute): DataChannelDefinition {
  return {
    name: route.name,
    protocol: route.protocol,
    endpoint: route.endpoint,
    region: route.region,
    tags: route.tags,
    envoyPort: route.envoyPort,
  }
}

/** Returns the full route table safe for API exposure. */
export function toPublicRouteTable(state: RouteTable): PublicRouteTable {
  const internalRoutes: PublicInternalRoute[] = []
  for (const innerMap of state.internal.routes.values()) {
    for (const r of innerMap.values()) {
      internalRoutes.push(toPublicInternalRoute(r))
    }
  }
  return {
    routes: {
      local: [...state.local.routes.values()],
      internal: internalRoutes,
    },
    peers: [...state.internal.peers.values()].map(toPublicPeer),
  }
}

/** Total number of internal routes across all peers. */
export function internalRouteCount(state: RouteTable): number {
  return [...state.internal.routes.values()].reduce((n, m) => n + m.size, 0)
}
