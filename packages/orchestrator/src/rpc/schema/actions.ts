
import { z } from 'zod';


import { LocalRoutingActionsSchema } from '../../plugins/implementations/local-routing.js';
import { IBGPConfigSchema, IBGPProtocolSchema } from './peering.js';

export const ActionSchema = z.union([
    LocalRoutingActionsSchema,
    IBGPProtocolSchema,
    IBGPConfigSchema
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.discriminatedUnion("success", [
    z.object({
        success: z.literal(true),
    }),
    z.object({
        success: z.literal(false),
        error: z.string(),
    })
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;
