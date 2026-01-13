
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';

export class RouteTablePlugin extends BasePlugin {
    name = 'RouteTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // Apply logic based on action
        if (action.resource === 'dataChannel') {
            if (action.action === 'create') {
                // Mutate the state (RouteTable) - Internal by default for this plugin
                // Ignore Proxy protocols handled by DirectProxyRouteTablePlugin
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    return { success: true, ctx: context };
                }

                const id = state.addInternalRoute({
                    name: action.data.name,
                    endpoint: action.data.endpoint!,
                    protocol: action.data.protocol,
                    region: action.data.region
                });
                context.result = { ...context.result, id };
            } else if (action.action === 'update') {
                // Ignore Proxy protocols handled by DirectProxyRouteTablePlugin
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    return { success: true, ctx: context };
                }

                const id = state.updateInternalRoute({
                    name: action.data.name,
                    endpoint: action.data.endpoint!,
                    protocol: action.data.protocol,
                    region: action.data.region
                });

                if (id) {
                    context.result = { ...context.result, id };
                } else {
                    return {
                        success: false,
                        error: {
                            pluginName: this.name,
                            message: `Route not found for update: ${action.data.name}:${action.data.protocol}`
                        }
                    };
                }
            } else if (action.action === 'delete') {
                // Delete works for all route types - removeRoute checks all maps
                const id = action.data.id;
                state.removeRoute(id);
                context.result = { ...context.result, id };
            }
        }

        return { success: true, ctx: context };
    }
}
