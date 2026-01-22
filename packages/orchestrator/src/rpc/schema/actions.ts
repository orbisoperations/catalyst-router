
import { z } from 'zod';


import { LocalRoutingActionsSchema } from '../../plugins/implementations/local-routing.js';
import { InternalPeeringActionsSchema } from '../../plugins/implementations/Internal-bgp.js';

export const ActionSchema = z.union([
    LocalRoutingActionsSchema,
    InternalPeeringActionsSchema
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.object({
    success: z.boolean(),
    id: z.string().optional(),
    error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
