/**
 * Close reason codes for InternalProtocolClose.
 * Analogous to BGP NOTIFICATION codes (RFC 4271 §4.5).
 */
export const CloseCodes = {
  /** Normal shutdown (operator-initiated peer removal) */
  NORMAL: 1,
  /** Hold timer expired (no keepalive/update received within holdTime) */
  HOLD_EXPIRED: 2,
  /** Transport-level failure (WebSocket disconnect, RPC error) */
  TRANSPORT_ERROR: 3,
  /** Administrative shutdown (node shutting down gracefully) */
  ADMIN_SHUTDOWN: 4,
  /** Protocol error (malformed message, schema validation failure) */
  PROTOCOL_ERROR: 5,
} as const

export type CloseCode = (typeof CloseCodes)[keyof typeof CloseCodes]
