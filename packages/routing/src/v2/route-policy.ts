import type { PeerRecord, InternalRoute } from './state.js'

/** Per-peer route filtering policy. Determines which routes are sent to a given peer. */
export interface RoutePolicy {
  canSend(peer: PeerRecord, routes: InternalRoute[]): InternalRoute[]
}

/** Pass-through policy — sends all routes to all peers. Stub for future Cedar integration. */
export class ConfigurableRoutePolicy implements RoutePolicy {
  canSend(_peer: PeerRecord, routes: InternalRoute[]): InternalRoute[] {
    return routes
  }
}
