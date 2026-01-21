export interface OpenMessage {
    type: 'OPEN';
    version: number;
    asn: number;
    bgp_id: string; // The Router ID
    hold_time: number;

    // Security Fields
    timestamp: number; // For replay protection
    jwks_uri?: string; // For External Peering
    signature?: string; // Signed payload by AS Key

    // Capabilities (Multiprotocol extensions, etc.)
    capabilities: string[];
}

export interface OpenConfirmMessage {
    type: 'OPEN_CONFIRM';
    timestamp: number;
    signature?: string;
}

export interface NotificationMessage {
    type: 'NOTIFICATION';
    code: number;
    subcode: number;
    data?: unknown;
}

export interface KeepAliveMessage {
    type: 'KEEPALIVE';
}

export type PeerMessage =
    | OpenMessage
    | OpenConfirmMessage
    | NotificationMessage
    | KeepAliveMessage;
