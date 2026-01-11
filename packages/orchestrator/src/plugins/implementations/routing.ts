
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';

export class RouteTablePlugin extends BasePlugin {
    name = 'RouteTablePlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // Apply logic based on action
        if (action.resource === 'dataChannel') {
            if (action.action === 'create') {
                // Mutate the state (RouteTable)
                const id = state.addRoute(action.data);
                context.result = { ...context.result, id };
            }
            // Handle update/delete in future
        }

        return { success: true, ctx: context };
    }
}
