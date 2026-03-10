import type { PeerRecord, InternalRoute } from './state.js'
import type { DataChannelDefinition } from './datachannel.js'

/**
 * Per-peer route filtering policy.
 *
 * - canSend: filters outbound routes before advertising to a peer.
 * - canReceive: filters inbound routes before accepting from a peer.
 */
export interface RoutePolicy {
  canSend(peer: PeerRecord, routes: InternalRoute[]): InternalRoute[]
  canReceive(peer: PeerRecord, routes: DataChannelDefinition[]): DataChannelDefinition[]
}

/**
 * Pass-through policy — accepts and sends all routes to/from all peers.
 * For M3 (External Peering), this will be backed by Cedar policy evaluation to filter
 * route imports/exports between nodes of different organizations. See ADR-0015 and
 * docs/reference/milestones.md §Milestone 3.
 */
export class ConfigurableRoutePolicy implements RoutePolicy {
  canSend(_peer: PeerRecord, routes: InternalRoute[]): InternalRoute[] {
    return routes
  }

  canReceive(_peer: PeerRecord, routes: DataChannelDefinition[]): DataChannelDefinition[] {
    return routes
  }
}
