/**
 * Action type constants - single source of truth for all action strings.
 * Schemas and handlers reference these constants.
 */
export const Actions = {
  // Local peer management
  LocalPeerCreate: 'local:peer:create',
  LocalPeerUpdate: 'local:peer:update',
  LocalPeerDelete: 'local:peer:delete',

  // Local route management
  LocalRouteCreate: 'local:route:create',
  LocalRouteDelete: 'local:route:delete',

  // Internal protocol (iBGP peering)
  InternalProtocolOpen: 'internal:protocol:open',
  InternalProtocolClose: 'internal:protocol:close',
  InternalProtocolConnected: 'internal:protocol:connected',
  InternalProtocolUpdate: 'internal:protocol:update',

  // System
  Tick: 'system:tick',
} as const

export type ActionType = (typeof Actions)[keyof typeof Actions]
