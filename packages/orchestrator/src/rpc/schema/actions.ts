
import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';
import { PeerInfoSchema, UpdateMessageSchema } from './peering.js';

export const DataChannelCreateActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('create'),
    data: ServiceDefinitionSchema,
});

export const DataChannelUpdateActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('update'),
    data: ServiceDefinitionSchema,
});

export const DataChannelDeleteActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('delete'),
    data: z.object({ id: z.string() }),
});

export const PeerCreateActionSchema = z.object({
    resource: z.literal('peer'),
    action: z.literal('create'),
    data: z.object({
        address: z.string(),
        secret: z.string(),
    }),
});

export const ActionSchema = z.union([
    DataChannelCreateActionSchema,
    DataChannelUpdateActionSchema,
    DataChannelDeleteActionSchema,
    PeerCreateActionSchema,

    z.object({
        resource: z.literal('externalRoute'),
        action: z.literal('create'),
        data: ServiceDefinitionSchema
    }),
    // Use schema definitions for robustness if complex, but here inline is fine for prototypes
    z.object({
        resource: z.literal('internal-peering-user'),
        action: z.literal('create'),
        data: z.object({
            endpoint: z.string(),
            info: PeerInfoSchema // Ensure PeerInfoSchema is exported often
        })
    }),
    z.object({
        resource: z.literal('internal-peering-user'),
        action: z.literal('update'),
        data: z.object({
            peerId: z.string(),
            info: PeerInfoSchema.partial()
        })
    }),
    z.object({
        resource: z.literal('internal-peering-user'),
        action: z.literal('delete'),
        data: z.object({ peerId: z.string() })
    }),
    z.object({
        resource: z.literal('internal-peering-protocol'),
        action: z.literal('open'),
        data: z.object({
            peerId: z.string(),
            info: PeerInfoSchema,
            jwks: z.any().optional()
        })
    }),
    z.object({
        resource: z.literal('internal-peering-protocol'),
        action: z.literal('keepalive'),
        data: z.object({ peerId: z.string() })
    }),
    z.object({
        resource: z.literal('internal-peering-protocol'),
        action: z.literal('update'),
        data: z.object({
            peerId: z.string(),
            update: UpdateMessageSchema
        })
    }),
    z.object({
        resource: z.literal('internal-peering-protocol'),
        action: z.literal('notification'),
        data: z.object({
            peerId: z.string(),
            code: z.string(),
            message: z.string()
        })
    })
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.object({
    success: z.boolean(),
    id: z.string().optional(),
    error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
