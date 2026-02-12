import { z } from 'zod'
import { PeerInfoSchema } from '../state.js'
import { DataChannelDefinitionSchema } from '../datachannel.js'
import { Actions } from '../action-types.js'

// Re-export for backward compatibility with existing imports
export const internalProtocolOpenAction = z.literal(Actions.InternalProtocolOpen)
export const internalProtocolUpdateAction = z.literal(Actions.InternalProtocolUpdate)
export const internalProtocolCloseAction = z.literal(Actions.InternalProtocolClose)
export const internalProtocolConnectedAction = z.literal(Actions.InternalProtocolConnected)

// Data Schemas
export const UpdateMessageSchema = z.object({
  updates: z.array(
    z.object({
      action: z.enum(['add', 'remove'] as const),
      route: DataChannelDefinitionSchema,
      nodePath: z.array(z.string()).optional(),
    })
  ),
})

export const InternalProtocolOpenMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolOpen),
  data: z.object({
    peerInfo: PeerInfoSchema,
    holdTime: z.number().optional(),
  }),
})

export const InternalProtocolUpdateMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolUpdate),
  data: z.object({
    peerInfo: PeerInfoSchema,
    update: UpdateMessageSchema,
  }),
})

export const InternalProtocolCloseMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolClose),
  data: z.object({
    peerInfo: PeerInfoSchema,
    code: z.number(),
    reason: z.string().optional(),
  }),
})

export const InternalProtocolConnectedMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolConnected),
  data: z.object({
    peerInfo: PeerInfoSchema,
    holdTime: z.number().optional(),
  }),
})

export const internalProtocolKeepaliveAction = z.literal(Actions.InternalProtocolKeepalive)
export const internalProtocolTickAction = z.literal(Actions.InternalProtocolTick)

export const InternalProtocolKeepaliveMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolKeepalive),
  data: z.object({
    peerInfo: PeerInfoSchema,
  }),
})

export const InternalProtocolTickMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolTick),
  data: z.object({}),
})
