import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';
import { getConfig } from '../../config.js';

export class InternalRouteTablePlugin extends BasePlugin {
    name = 'InternalRouteTablePlugin';

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

                // Validate FQDN against configured domains
                const config = getConfig();
                const isValidDomain = config.peering.domains.some(d => action.data.fqdn.endsWith(d));

                if (!isValidDomain) {
                    console.warn(`[InternalRouteTablePlugin] Rejected route ${action.data.name}: FQDN ${action.data.fqdn} does not match hosted domains (${config.peering.domains.join(', ')})`);
                    return {
                        success: false,
                        error: {
                            pluginName: this.name,
                            message: `FQDN ${action.data.fqdn} is not authorized for this node.`
                        },
                        ctx: context
                    } as PluginResult;
                }

                const { state: newState, id } = state.addInternalRoute({
                    name: action.data.name,
                    fqdn: action.data.fqdn,
                    endpoint: action.data.endpoint!,
                    protocol: action.data.protocol,
                    region: action.data.region,
                    authEndpoint: action.data.authEndpoint
                });

                context.state = newState;
                context.result = { ...context.result, id };
            } else if (action.action === 'update') {
                // Ignore Proxy protocols handled by DirectProxyRouteTablePlugin
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    return { success: true, ctx: context };
                }

                const result = state.updateInternalRoute({
                    name: action.data.name,
                    fqdn: action.data.fqdn,
                    endpoint: action.data.endpoint!,
                    protocol: action.data.protocol,
                    region: action.data.region
                });

                if (result) {
                    const { state: newState, id } = result;
                    context.state = newState;
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
                const newState = state.removeRoute(id);
                context.state = newState;
                context.result = { ...context.result, id };
            }
        }

        return { success: true, ctx: context };
    }
}
