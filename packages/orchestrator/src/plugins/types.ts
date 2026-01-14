import { z } from 'zod';
import { ActionSchema } from '../rpc/schema/index.js';
export { ActionSchema };
import { RouteTable } from '../state/route-table.js';

export const AuthContextSchema = z.object({
    userId: z.string().optional(),
    orgId: z.string().optional(),
    roles: z.array(z.string()).optional(),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export interface PipelineAction {
    resource: string;
    action?: string;
    data: any;
}

export const PluginContextSchema = z.object({
    action: z.custom<PipelineAction>(),
    state: z.instanceof(RouteTable),
    authxContext: AuthContextSchema,
    results: z.array(z.any()).default([]),
});
export type PluginContext = z.infer<typeof PluginContextSchema>;

export const PluginResultSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        ctx: PluginContextSchema,
    }),
    z.object({
        success: z.literal(false),
        error: z.object({
            pluginName: z.string(),
            message: z.string(),
            error: z.any().optional(),
        }),
    }),
]);
export type PluginResult = z.infer<typeof PluginResultSchema>;

export interface PluginInterface {
    name: string;
    apply(context: PluginContext): Promise<PluginResult>;
}
