import { z } from 'zod'
import {
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
} from './routing/local/actions'

/**
 * Unified Action Schema
 */
export const ActionSchema = z.discriminatedUnion('action', [
  localPeerCreateMessageSchema,
  localPeerUpdateMessageSchema,
  localPeerDeleteMessageSchema,
])

export type Action = z.infer<typeof ActionSchema>
