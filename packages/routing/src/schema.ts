import { z } from 'zod'
import {
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
  localRouteCreateMessageSchema,
  localRouteDeleteMessageSchema,
} from './local/actions.js'
import {
  InternalProtocolOpenMessageSchema,
  InternalProtocolUpdateMessageSchema,
  InternalProtocolCloseMessageSchema,
  InternalProtocolConnectedMessageSchema,
} from './internal/actions.js'
import { TickMessageSchema } from './system/actions.js'

/**
 * Unified Action Schema
 */
export const ActionSchema = z.discriminatedUnion('action', [
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
  localRouteCreateMessageSchema,
  localRouteDeleteMessageSchema,
  InternalProtocolOpenMessageSchema,
  InternalProtocolUpdateMessageSchema,
  InternalProtocolCloseMessageSchema,
  InternalProtocolConnectedMessageSchema,
  TickMessageSchema,
])

export type Action = z.infer<typeof ActionSchema>
