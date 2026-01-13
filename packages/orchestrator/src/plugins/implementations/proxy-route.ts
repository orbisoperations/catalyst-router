
import { BasePlugin } from '../base.js';
import {
    Action,
    ServiceDefinition,
    AddDataChannelResult
} from '../../rpc/schema/index.js';
import { PluginContext, PluginResult } from '../types.js';
import { getConfig } from '../../config.js';

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
                    const { name, endpoint, region, fqdn } = action.data;

                    // Validate FQDN against configured domains
                    const config = getConfig();
                    const isValidDomain = config.peering.domains.some(d => fqdn?.endsWith(d));

                    if (fqdn && !isValidDomain) {
                        console.warn(`[DirectProxyRouteTablePlugin] Rejected route ${name}: FQDN ${fqdn} does not match hosted domains (${config.peering.domains.join(', ')})`);
                        return {
                            success: false,
                            error: {
                                pluginName: this.name,
                                message: `FQDN ${fqdn} is not authorized for this node.`
                            },
                        } as PluginResult;
                    }

                    const serviceDef: ServiceDefinition = {
                        name,
                        fqdn: fqdn || `${name}.internal`,
                        endpoint: endpoint!,
                        protocol,
                        region
                    };

                    const { state: newState, id } = state.addProxiedRoute(serviceDef);

                    context.state = newState;
                    context.result = { ...context.result, id };
                }
            } else if (action.action === 'update') {
                // Update Routes as Proxied - Only if protocol matches
                const protocol = action.data.protocol;
                if (protocol === 'tcp:graphql' || protocol === 'tcp:gql') {
                    console.log(`[DirectProxyRouteTablePlugin] Updating route for ${action.data.name}`);

                    const { name, endpoint, region, fqdn } = action.data;

                    // Validate FQDN against configured domains
                    const config = getConfig();
                    const isValidDomain = config.peering.domains.some(d => fqdn?.endsWith(d));

                    if (fqdn && !isValidDomain) {
                        console.warn(`[DirectProxyRouteTablePlugin] Rejected update for route ${name}: FQDN ${fqdn} does not match hosted domains (${config.peering.domains.join(', ')})`);
                        return {
                            success: false,
                            error: {
                                pluginName: this.name,
                                message: `FQDN ${fqdn} is not authorized for this node.`
                            },
                        } as PluginResult;
                    }

                    const serviceDef: ServiceDefinition = {
                        name,
                        fqdn: fqdn || `${name}.internal`,
                        endpoint: endpoint!,
                        protocol,
                        region
                    };

                    const result = state.updateProxiedRoute(serviceDef);

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
                }
            } else if (action.action === 'delete') {
                // Delete works for all route types - removeRoute checks all maps
                const id = action.data.id;
                // removeRoute returns the new state regardless of whether it found the route (idempotent-ish for delete logic here)
                const newState = state.removeRoute(id);
                context.state = newState;
                context.result = { ...context.result, id };
            }
        }

        return { success: true, ctx: context };
    }
}
