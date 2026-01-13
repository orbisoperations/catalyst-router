
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';

export class ExternalRouteTablePlugin extends BasePlugin {
    name = 'ExternalRouteTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // Apply logic based on action
        if (action.resource === 'externalRoute') {
            if (action.action === 'create') {
                // Add to external routes
                // We do NOT validate FQDN against *local* domains here, because it's external!
                // We might validate against peering policy in the future

                const { state: newState, id } = state.addExternalRoute({
                    name: action.data.name,
                    fqdn: action.data.fqdn,
                    endpoint: action.data.endpoint!,
                    protocol: action.data.protocol,
                    region: action.data.region,
                    jwks: action.data.jwks
                });
                context.state = newState;
                context.result = { ...context.result, id };
            }
        }

        return { success: true, ctx: context };
    }
}
