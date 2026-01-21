
import type { PluginInterface, PluginContext, PluginResult } from './types.js';

export abstract class BasePlugin implements PluginInterface {
    abstract name: string;

    async apply(context: PluginContext): Promise<PluginResult> {
        return { success: true, ctx: context };
    }
}
