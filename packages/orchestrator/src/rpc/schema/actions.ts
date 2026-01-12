
import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';

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
    PeerCreateActionSchema
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.object({
    success: z.boolean(),
    id: z.string().optional(),
    error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
