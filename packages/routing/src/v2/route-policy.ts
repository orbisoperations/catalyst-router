import type { PeerRecord, InternalRoute } from './state.js'

/** Per-peer route filtering policy. Determines which routes are sent to a given peer. */
export interface RoutePolicy {
  canSend(peer: PeerRecord, routes: InternalRoute[]): InternalRoute[]
}

/**
 * Pass-through policy — sends all routes to all peers.
 * For M3 (External Peering), this will be backed by Cedar policy evaluation to filter
 * route exports between nodes of different organizations. See ADR-0015 and
 * docs/reference/milestones.md §Milestone 3.
 */
export class ConfigurableRoutePolicy implements RoutePolicy {
  canSend(_peer: PeerRecord, routes: InternalRoute[]): InternalRoute[] {
    return routes
  }
}
