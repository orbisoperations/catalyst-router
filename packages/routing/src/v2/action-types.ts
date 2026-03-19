/**
 * Action type constants - single source of truth for all action strings.
 * V2: adds InternalProtocolKeepalive for dedicated keepalive messages.
 */
export const Actions = {
  // Local peer management
  LocalPeerCreate: 'local:peer:create',
  LocalPeerUpdate: 'local:peer:update',
  LocalPeerDelete: 'local:peer:delete',

  // Local route management
  LocalRouteCreate: 'local:route:create',
  LocalRouteDelete: 'local:route:delete',
  LocalRouteHealthUpdate: 'local:route:health-update',

  // Internal protocol (peering)
  InternalProtocolOpen: 'internal:protocol:open',
  InternalProtocolClose: 'internal:protocol:close',
  InternalProtocolConnected: 'internal:protocol:connected',
  InternalProtocolUpdate: 'internal:protocol:update',
  InternalProtocolKeepalive: 'internal:protocol:keepalive',

  // System
  Tick: 'system:tick',
} as const

export type ActionType = (typeof Actions)[keyof typeof Actions]
