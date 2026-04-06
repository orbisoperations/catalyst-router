import { z } from 'zod'
import {
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
  localRouteCreateMessageSchema,
  localRouteDeleteMessageSchema,
  localRouteHealthUpdateMessageSchema,
} from './local/actions.js'
import {
  InternalProtocolOpenMessageSchema,
  InternalProtocolUpdateMessageSchema,
  InternalProtocolCloseMessageSchema,
  InternalProtocolConnectedMessageSchema,
  InternalProtocolKeepaliveMessageSchema,
} from './internal/actions.js'
import {
  TickMessageSchema,
  AdminGracefulShutdownMessageSchema,
  AdminCancelShutdownMessageSchema,
} from './system/actions.js'

/**
 * Unified Action Schema — V2.
 * Includes InternalProtocolKeepalive for dedicated keepalive messages.
 */
export const ActionSchema = z.discriminatedUnion('action', [
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
  localRouteCreateMessageSchema,
  localRouteDeleteMessageSchema,
  localRouteHealthUpdateMessageSchema,
  InternalProtocolOpenMessageSchema,
  InternalProtocolUpdateMessageSchema,
  InternalProtocolCloseMessageSchema,
  InternalProtocolConnectedMessageSchema,
  InternalProtocolKeepaliveMessageSchema,
  TickMessageSchema,
  AdminGracefulShutdownMessageSchema,
  AdminCancelShutdownMessageSchema,
])

export type Action = z.infer<typeof ActionSchema>
