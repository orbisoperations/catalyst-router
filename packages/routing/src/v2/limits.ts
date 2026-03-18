/**
 * Protocol-level limits for WebSocket payload validation.
 * Single source of truth — import from here, don't redeclare.
 */

/** Maximum number of tags on a data channel definition. */
export const MAX_TAGS_PER_CHANNEL = 32

/** Maximum length of an endpoint URL string. */
export const MAX_ENDPOINT_LENGTH = 2048

/** Maximum number of route updates in a single iBGP message. */
export const MAX_UPDATES_PER_MESSAGE = 1000

/** Maximum number of hops in a route path (loop protection). */
export const MAX_NODE_PATH_HOPS = 64

/** Maximum length of a node identifier string. */
export const MAX_NODE_ID_LENGTH = 253
