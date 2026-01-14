
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult, PipelineAction } from '../types.js';
import { DataChannel } from '../../types.js';
import { ServiceDefinitionSchema } from '../../rpc/schema/direct.js';
import { z } from 'zod';

export const LocalRoutingCreateDataChannelSchema = z.object({
    resource: z.literal('local-routing'),
    action: z.literal('create-datachannel'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingUpdateDataChannelSchema = z.object({
    resource: z.literal('local-routing'),
    action: z.literal('update-datachannel'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingDeleteDataChannelSchema = z.object({
    resource: z.literal('local-routing'),
    action: z.literal('delete-datachannel'),
    data: z.object({ id: z.string() }),
});

export const LocalRoutingActionsSchema = z.union([
    LocalRoutingCreateDataChannelSchema,
    LocalRoutingUpdateDataChannelSchema,
    LocalRoutingDeleteDataChannelSchema,
]);

export type LocalRoutingAction = z.infer<typeof LocalRoutingActionsSchema>;

export class LocalRoutingTablePlugin extends BasePlugin {
    name = 'LocalRoutingTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // Check if this is a local-routing action
        if (action.resource !== 'local-routing') {
            return { success: true, ctx: context };
        }

        if (action.action === 'create-datachannel') {
            const data = action.data as DataChannel;

            // Logic: Distinguish by protocol
            if (data.protocol === 'tcp:graphql' || data.protocol === 'tcp:gql') {
                // Proxy Route
                console.log(`[LocalRoutingTablePlugin] Adding PROXY route for ${data.name}`);
                const { state: newState, id } = state.addProxiedRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });
                context.state = newState;
                context.result = { ...context.result, id };
            } else {
                // Internal Route
                console.log(`[LocalRoutingTablePlugin] Adding INTERNAL route for ${data.name}`);
                const { state: newState, id } = state.addInternalRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });
                context.state = newState;
                context.result = { ...context.result, id };
            }

        } else if (action.action === 'update-datachannel') {
            const data = action.data as DataChannel;

            if (data.protocol === 'tcp:graphql' || data.protocol === 'tcp:gql') {
                // Proxy Route
                const result = state.updateProxiedRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });

                if (result) {
                    context.state = result.state;
                    context.result = { ...context.result, id: result.id };
                } else {
                    return {
                        success: false,
                        error: {
                            pluginName: this.name,
                            message: `Proxy route not found for update: ${data.name}:${data.protocol}`
                        }
                    };
                }
            } else {
                // Internal Route
                const result = state.updateInternalRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });

                if (result) {
                    context.state = result.state;
                    context.result = { ...context.result, id: result.id };
                } else {
                    return {
                        success: false,
                        error: {
                            pluginName: this.name,
                            message: `Internal route not found for update: ${data.name}:${data.protocol}`
                        }
                    };
                }
            }

        } else if (action.action === 'delete-datachannel') {
            const { id } = action.data as { id: string };
            // removeRoute works for both internal and proxied maps within RouteTable
            const newState = state.removeRoute(id);
            context.state = newState;
            context.result = { ...context.result, id };
        }

        return { success: true, ctx: context };
    }
}
