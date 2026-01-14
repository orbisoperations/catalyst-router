
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
                if (protocol === 'http:graphql' || protocol === 'http:gql') {
                    state.addProxiedRoute({
                        name: action.data.name,
                        endpoint: action.data.endpoint!,
                        protocol: action.data.protocol,
                        region: action.data.region
                    });
                }
            }
        }

        return { success: true, ctx: context };
    }
}
