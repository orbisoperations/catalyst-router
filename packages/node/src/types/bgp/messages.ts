/**
 * BGP Message Definitions
 * 
 * This file contains the TypeScript definitions for the BGP protocol messages
 * adapted for service discovery in Catalyst Node.
 * 
 * @see {@link ../../../BGP_PROTOCOL.md|BGP Protocol Documentation}
 */

// Discriminated union for all BGP message types
export type BgpMessage =
    | OpenMessage
    | KeepAliveMessage
    | UpdateMessage
    | NotificationMessage;

export enum BgpMessageType {
    OPEN = 'OPEN',
    KEEPALIVE = 'KEEPALIVE',
    UPDATE = 'UPDATE',
    NOTIFICATION = 'NOTIFICATION',
}

/**
 * Default Hold Time in seconds.
 * The suggested default is 180 seconds.
 */
export const DEFAULT_HOLD_TIME = 180;

/**
 * The ratio of Hold Time to Keepalive Interval.
 * Keepalives should be sent at least every (Hold Time / 3) seconds.
 */
export const KEEPALIVE_RATIO = 3;

/**
 * OPEN Message
 * Sent immediately upon connection establishment to negotiate capabilities.
 */
export interface OpenMessage {
    type: BgpMessageType.OPEN;
    version: number;
    myAsn: number; // Autonomous System Number of the sender
    holdTime: number; // Max seconds between KEEPALIVEs
    bgpIdentifier: string; // Unique Node ID of the sender
    capabilities: BgpCapability[];
    jwks?: Record<string, unknown>; // JSON Web Key Set
    psk?: string; // Pre-Shared Key identifier
}

export interface BgpCapability {
    code: number;
    length: number;
    value: unknown;
}

/**
 * KEEPALIVE Message
 * Sent periodically to maintain the session.
 */
export interface KeepAliveMessage {
    type: BgpMessageType.KEEPALIVE;
}

/**
 * UPDATE Message
 * Used to transfer routing information between peers.
 */
export interface UpdateMessage {
    type: BgpMessageType.UPDATE;

    /**
     * Routes that are no longer available and should be removed.
     */
    withdrawnRoutes: ServicePrefix[];

    /**
     * Path attributes for the new routes being advertised.
     */
    pathAttributes?: PathAttributes;

    /**
     * Network Layer Reachability Information (NLRI)
     * The new routes being advertised.
     */
    nlri: ServicePrefix[];
}

export type ServicePrefix = string; // e.g., "users.dc01.orbis"

export interface PathAttributes {
    asPath: number[]; // Sequence of ASNs
    nextHop: string; // Node ID of the next hop
    localPref?: number; // Preference for iBGP
    communities?: string[]; // Policy tags
    origin?: 'IGP' | 'EGP' | 'INCOMPLETE';
}

/**
 * NOTIFICATION Message
 * Sent when an error condition is detected. The connection closes after this.
 */
export interface NotificationMessage {
    type: BgpMessageType.NOTIFICATION;
    errorCode: BgpErrorCode;
    errorSubcode: number;
    data?: unknown;
}

export enum BgpErrorCode {
    MESSAGE_HEADER_ERROR = 1,
    OPEN_MESSAGE_ERROR = 2,
    UPDATE_MESSAGE_ERROR = 3,
    HOLD_TIMER_EXPIRED = 4,
    FSM_ERROR = 5,
    CEASE = 6,
}
