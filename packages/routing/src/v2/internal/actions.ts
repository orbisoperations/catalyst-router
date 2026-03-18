import { z } from 'zod'
import { PeerInfoSchema } from '../state.js'
import { DataChannelDefinitionSchema } from '../datachannel.js'
import { Actions } from '../action-types.js'
import { MAX_UPDATES_PER_MESSAGE, MAX_NODE_PATH_HOPS, MAX_NODE_ID_LENGTH } from '../limits.js'

export { MAX_UPDATES_PER_MESSAGE, MAX_NODE_PATH_HOPS, MAX_NODE_ID_LENGTH }

// Re-export for backward compatibility with existing imports
export const internalProtocolOpenAction = z.literal(Actions.InternalProtocolOpen)
export const internalProtocolUpdateAction = z.literal(Actions.InternalProtocolUpdate)
export const internalProtocolCloseAction = z.literal(Actions.InternalProtocolClose)
export const internalProtocolConnectedAction = z.literal(Actions.InternalProtocolConnected)
export const internalProtocolKeepaliveAction = z.literal(Actions.InternalProtocolKeepalive)

// Data Schemas

/**
 * V2: nodePath is REQUIRED (min 1) and originNode is a new required field.
 * This enforces that every route advertisement carries full path attribution.
 */

export const UpdateMessageSchema = z.object({
  updates: z
    .array(
      z.object({
        action: z.enum(['add', 'remove'] as const),
        route: DataChannelDefinitionSchema,
        nodePath: z.array(z.string().max(MAX_NODE_ID_LENGTH)).min(1).max(MAX_NODE_PATH_HOPS),
        originNode: z.string().max(MAX_NODE_ID_LENGTH),
      })
    )
    .max(MAX_UPDATES_PER_MESSAGE),
})

/**
 * V2: adds optional holdTime for keepalive interval negotiation during open.
 */
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
  }),
})

/**
 * V2: dedicated keepalive message sent on the holdTime interval to prevent
 * session expiry when no route updates are flowing.
 */
export const InternalProtocolKeepaliveMessageSchema = z.object({
  action: z.literal(Actions.InternalProtocolKeepalive),
  data: z.object({
    peerInfo: PeerInfoSchema,
  }),
})
