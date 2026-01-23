import { z } from "zod";
import { PeerInfoSchema } from "../state.js";

// Action Types
export const internalProtocolOpenAction = z.literal("internal:protocol:open");
export const internalProtocolUpdateAction = z.literal("internal:protocol:update");
export const internalProtocolCloseAction = z.literal("internal:protocol:close");

// Data Schemas
import { DataChannelDefinitionSchema } from "../datachannel.js";

// Data Schemas
export const UpdateMessageSchema = z.object({
    updates: z.array(z.object({
        action: z.enum(['add', 'remove']),
        route: DataChannelDefinitionSchema
    }))
});

export const InternalProtocolOpenMessageSchema = z.object({
    action: internalProtocolOpenAction,
    data: z.object({
        peerInfo: PeerInfoSchema
    })
});

export const InternalProtocolUpdateMessageSchema = z.object({
    action: internalProtocolUpdateAction,
    data: z.object({
        peerInfo: PeerInfoSchema,
        update: UpdateMessageSchema
    })
});

export const InternalProtocolCloseMessageSchema = z.object({
    action: internalProtocolCloseAction,
    data: z.object({
        peerInfo: PeerInfoSchema,
        code: z.number(),
        reason: z.string().optional()
    })
});

export const internalProtocolConnectedAction = z.literal("internal:protocol:connected");

export const InternalProtocolConnectedMessageSchema = z.object({
    action: internalProtocolConnectedAction,
    data: z.object({
        peerInfo: PeerInfoSchema
    })
});
