
import { BasePlugin } from '../base.js';
import type { PluginContext, PluginResult } from '../types.js';
import { ServiceDefinitionSchema } from '../../rpc/schema/direct.js';
import { z } from 'zod';

export const LocalRoutingCreateActionSchema = z.object({
    resource: z.literal('localRoute'),
    resourceAction: z.literal('create'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingUpdateActionSchema = z.object({
    resource: z.literal('localRoute'),
    resourceAction: z.literal('update'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingDeleteActionSchema = z.object({
    resource: z.literal('localRoute'),
    resourceAction: z.literal('delete'),
    data: z.object({ id: z.string() }),
});

export const LocalRoutingActionsSchema = z.union([
    LocalRoutingCreateActionSchema,
    LocalRoutingUpdateActionSchema,
    LocalRoutingDeleteActionSchema,
]);

export type LocalRoutingAction = z.infer<typeof LocalRoutingActionsSchema>;

export class LocalRoutingTablePlugin extends BasePlugin {
    name = 'LocalRoutingTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;



        if (action.resource !== 'localRoute') {
            return { success: true, ctx: context };
        }

        if (action.resourceAction === 'create') {
            const data = action.data as z.infer<typeof ServiceDefinitionSchema>;

            // Logic: Distinguish by protocol
            if (data.protocol === 'http:graphql' || data.protocol === 'http:gql') {
                // Proxy Route
                console.log(`[LocalRoutingTablePlugin] Adding PROXY route for ${data.name}`);
                const { state: newState, id } = state.addProxiedRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });
                context.state = newState;
                context.results.push({
                    plugin: this.name,
                    resource: action.resource,
                    resourceAction: action.resourceAction,
                    id,
                    name: data.name,
                    protocol: data.protocol,
                    type: 'proxy-route-created'
                });
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
                context.results.push({
                    plugin: this.name,
                    resource: action.resource,
                    resourceAction: action.resourceAction,
                    id,
                    name: data.name,
                    protocol: data.protocol,
                    type: 'internal-route-created'
                });
            }

        } else if (action.resourceAction === 'update') {
            const data = action.data as z.infer<typeof ServiceDefinitionSchema>;

            if (data.protocol === 'http:graphql' || data.protocol === 'http:gql') {
                // Proxy Route
                const result = state.updateProxiedRoute({
                    name: data.name,
                    endpoint: data.endpoint!,
                    protocol: data.protocol,
                    region: data.region
                });

                if (result) {
                    context.state = result.state;
                    context.results.push({
                        plugin: this.name,
                        resource: action.resource,
                        resourceAction: action.resourceAction,
                        id: result.id,
                        name: data.name,
                        protocol: data.protocol,
                        type: 'proxy-route-updated'
                    });
                } else {
                    return {
                        success: false,
                        ctx: context,
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
                    context.results.push({
                        plugin: this.name,
                        resource: action.resource,
                        resourceAction: action.resourceAction,
                        id: result.id,
                        name: data.name,
                        protocol: data.protocol,
                        type: 'internal-route-updated'
                    });
                } else {
                    return {
                        success: false,
                        ctx: context,
                        error: {
                            pluginName: this.name,
                            message: `Internal route not found for update: ${data.name}:${data.protocol}`
                        }
                    };
                }
            }

        } else if (action.resourceAction === 'delete') {
            const { id } = action.data as { id: string };
            // removeRoute works for both internal and proxied maps within RouteTable
            const newState = state.removeRoute(id);
            context.state = newState;
            context.results.push({
                plugin: this.name,
                resource: action.resource,
                resourceAction: action.resourceAction,
                id,
                type: 'route-deleted'
            });
        }

        return { success: true, ctx: context };
    }
}
