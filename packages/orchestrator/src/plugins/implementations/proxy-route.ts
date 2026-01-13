
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';

export class DirectProxyRouteTablePlugin extends BasePlugin {
    name = 'DirectProxyRouteTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // This plugin specifically handles 'proxied' routes if we were distinguishing them.

        if (action.resource === 'dataChannel') {
            if (action.action === 'create') {
                console.log(`[DirectProxyRouteTablePlugin] Processing route for ${action.data.name}`);

                // Add to Routes as Proxied - Only if protocol matches
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    const id = state.addProxiedRoute({
                        name: action.data.name,
                        endpoint: action.data.endpoint!,
                        protocol: action.data.protocol,
                        region: action.data.region
                    });
                    context.result = { ...context.result, id };
                }
            } else if (action.action === 'update') {
                // Update Routes as Proxied - Only if protocol matches
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    console.log(`[DirectProxyRouteTablePlugin] Updating route for ${action.data.name}`);

                    const id = state.updateProxiedRoute({
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
