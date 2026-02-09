import { z } from 'zod'
import { PeerInfoSchema } from '../state.js'
import { DataChannelDefinitionSchema } from '../datachannel.js'
import { Actions } from '../action-types.js'

// Re-export for backward compatibility with existing imports
export const localPeerCreateAction = z.literal(Actions.LocalPeerCreate)
export const localPeerUpdateAction = z.literal(Actions.LocalPeerUpdate)
export const localPeerDeleteAction = z.literal(Actions.LocalPeerDelete)
export const localRouteCreateAction = z.literal(Actions.LocalRouteCreate)
export const localRouteDeleteAction = z.literal(Actions.LocalRouteDelete)

export const localPeerCreateMessageSchema = z.object({
  action: z.literal(Actions.LocalPeerCreate),
  data: PeerInfoSchema,
})

export const localPeerUpdateMessageSchema = z.object({
  action: z.literal(Actions.LocalPeerUpdate),
  data: PeerInfoSchema,
})

export const localPeerDeleteMessageSchema = z.object({
  action: z.literal(Actions.LocalPeerDelete),
  data: z
    .object({
      name: z.string(),
    })
    .and(PeerInfoSchema.partial()),
})

export const localRouteCreateMessageSchema = z.object({
  action: z.literal(Actions.LocalRouteCreate),
  data: DataChannelDefinitionSchema,
})

export const localRouteDeleteMessageSchema = z.object({
  action: z.literal(Actions.LocalRouteDelete),
  data: DataChannelDefinitionSchema,
})
