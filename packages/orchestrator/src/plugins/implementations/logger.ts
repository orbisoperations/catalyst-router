
import { BasePlugin } from '../base.js';
import type { PluginContext, PluginResult } from '../types.js';

export class LoggerPlugin extends BasePlugin {
    name = 'LoggerPlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        console.log(`[LoggerPlugin] Action: ${context.action.resource} / ${context.action.resourceAction}`);
        if ('name' in context.action.data) {
            console.log(`[LoggerPlugin] Data: ${context.action.data.name}`);
        }
        return { success: true, ctx: context };
    }
}
