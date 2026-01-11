
import { PluginInterface, PluginContext, PluginResult } from './types.js';

export class PluginPipeline implements PluginInterface {
    name = 'PluginPipeline';
    private plugins: PluginInterface[];

    constructor(plugins: PluginInterface[], name: string = 'PluginPipeline') {
        this.plugins = plugins;
        this.name = name;
    }

    async apply(initialContext: PluginContext): Promise<PluginResult> {
        let context = initialContext;
        for (const plugin of this.plugins) {
            try {
                const result = await plugin.apply(context);
                if (!result.success) {
                    return result; // Propagate error immediately
                }
                context = result.ctx;
            } catch (error: any) {
                console.error(`[PluginPipeline] Error in plugin ${plugin.name}: ${error.message}`);
                return {
                    success: false,
                    error: {
                        pluginName: plugin.name,
                        message: `Unexpected error: ${error.message}`,
                        error
                    }
                };
            }
        }
        return { success: true, ctx: context };
    }
}
