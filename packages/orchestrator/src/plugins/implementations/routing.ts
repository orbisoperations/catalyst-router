
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
            }
            // Handle update/delete in future
        }

        return { success: true, ctx: context };
    }
}
