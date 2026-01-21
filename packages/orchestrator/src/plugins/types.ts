
import { z } from 'zod';
import { ActionSchema } from '../rpc/schema/index.js';
export { ActionSchema };
import { RouteTable } from '../state/route-table.js';

export const AuthContextSchema = z.object({
    userId: z.string(),
    roles: z.array(z.string()),
});
export type AuthContext = z.infer<typeof AuthContextSchema>;

export const PluginContextSchema = z.object({
    action: ActionSchema,
    state: z.instanceof(RouteTable),
    authxContext: AuthContextSchema,
    results: z.array(z.any()).default([]),
});
export type PluginContext = z.infer<typeof PluginContextSchema>;

export interface PluginResult {
    success: boolean;
    ctx: PluginContext;
    error?: {
        pluginName: string;
        message: string;
        error?: unknown;
    };
}

export interface PluginInterface {
    name: string;
    apply(context: PluginContext): Promise<PluginResult>;
}
