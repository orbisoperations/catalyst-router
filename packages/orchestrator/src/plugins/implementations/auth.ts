
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';

export class AuthPlugin extends BasePlugin {
    name = 'AuthPlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        // Stub: Check auth
        // In reality, verify context.authx matches requirements for context.action
        // console.log('[AuthPlugin] Verifying auth...');

        // For now, just allow everything
        return { success: true, ctx: context };
    }
}
