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

/** Returns peer data safe for API exposure — explicit allowlist, no credentials leak. */
export function peerToPublic(peer: PeerRecord): PublicPeer {
  return {
    name: peer.name,
    domains: peer.domains,
    endpoint: peer.endpoint,
    labels: peer.labels,
    connectionStatus: peer.connectionStatus,
    lastConnected: peer.lastConnected,
  }
}

/** Returns route safe for API exposure (peer credentials + isStale stripped). */
export function internalRouteToPublic(route: InternalRoute): PublicInternalRoute {
  const { peerToken: _, ...safePeer } = route.peer
  const { isStale: _stale, ...rest } = route
  return { ...rest, peer: safePeer }
}

/** Returns only DataChannelDefinition fields (strips peer, nodePath, originNode, isStale). */
export function internalRouteToDataChannel(route: InternalRoute): DataChannelDefinition {
  return {
    name: route.name,
    protocol: route.protocol,
    endpoint: route.endpoint,
    region: route.region,
    tags: route.tags,
    envoyPort: route.envoyPort,
    healthStatus: route.healthStatus,
    responseTimeMs: route.responseTimeMs,
    lastCheckedAt: route.lastCheckedAt,
  }
}

/** Returns the full route table safe for API exposure. */
export function routeTableToPublic(state: RouteTable): PublicRouteTable {
  const internalRoutes: PublicInternalRoute[] = []
  for (const innerMap of state.internal.routes.values()) {
    for (const r of innerMap.values()) {
      internalRoutes.push(internalRouteToPublic(r))
    }
  }
  return {
    routes: {
      local: [...state.local.routes.values()],
      internal: internalRoutes,
    },
    peers: [...state.internal.peers.values()].map(peerToPublic),
  }
}
