import { z } from 'zod'
import { PeerInfoSchema } from '../state'

export const localPeerCreateAction = z.literal('local:peer:create')
export const localPeerUpdateAction = z.literal('local:peer:update')
export const localPeerDeleteAction = z.literal('local:peer:delete')
export const localRouteCreateAction = z.literal('local:route:create')
export const localRouteDeleteAction = z.literal('local:route:delete')

export const localPeerCreateMessageSchema = z.object({
    action: localPeerCreateAction,
    data: PeerInfoSchema,
})

export const localPeerUpdateMessageSchema = z.object({
    action: localPeerUpdateAction,
    data: PeerInfoSchema,
})

export const localPeerDeleteMessageSchema = z.object({
    action: localPeerDeleteAction,
    data: z.object({
        name: z.string(),
    }).and(PeerInfoSchema.partial()),
})

import { DataChannelDefinitionSchema } from "../datachannel.js";

export const localRouteCreateMessageSchema = z.object({
    action: localRouteCreateAction,
    data: DataChannelDefinitionSchema,
})

export const localRouteDeleteMessageSchema = z.object({
    action: localRouteDeleteAction,
    data: DataChannelDefinitionSchema,
})
