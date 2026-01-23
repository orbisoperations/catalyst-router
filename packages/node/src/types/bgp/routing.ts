/**
 * BGP Routing Structure Definitions
 * 
 * This file defines the structures for routing tables and individual routes
 * used in the Catalyst Node service discovery system.
 */

import type { PathAttributes } from './messages';

/**
 * Represents a simplified route entry in the Routing Information Base (RIB).
 */
export interface ServiceRoute {
    prefix: string; // The service domain, e.g., "users.dc01.orbis"

    // Attributes derived from the UPDATE message
    attributes: PathAttributes;

    // Metadata for local processing
    receivedFrom: PeerInfo;
    receivedAt: Date;
    isBest: boolean; // Whether this is the currently selected best path
}

export interface PeerInfo {
    nodeId: string;
    asn: number;
    address: string; // Transport address
}

/**
 * Routing Information Base (RIB) types
 */
export interface AdjRibIn {
    // Routes received from peers, before filtering/selection
    // Map<PeerId, ServiceRoute[]>
    [peerId: string]: ServiceRoute[];
}

export interface LocRib {
    // The selected best routes (Local RIB)
    // Map<Prefix, ServiceRoute>
    [prefix: string]: ServiceRoute;
}

export interface AdjRibOut {
    // Routes to be advertised to specific peers
    // Map<PeerId, ServiceRoute[]>
    [peerId: string]: ServiceRoute[];
}

/**
 * The consolidated Route Table structure for a Node
 */
export interface RouteTable {
    // Internal routes (learned via iBGP or locally)
    internal: LocRib;

    // External routes (learned via eBGP)
    external: LocRib;
}
