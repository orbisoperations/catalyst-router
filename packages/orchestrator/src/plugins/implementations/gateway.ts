
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';
import { OrchestratorConfig } from '../../config.js';

export class GatewayIntegrationPlugin extends BasePlugin {
    name = 'GatewayIntegrationPlugin';
    private endpoint: string;

    constructor(config: OrchestratorConfig['gqlGatewayConfig']) {
        super();
        if (!config) {
            throw new Error('GatewayIntegrationPlugin requires gqlGatewayConfig');
        }
        this.endpoint = config.endpoint;
    }

    async apply(context: PluginContext): Promise<PluginResult> {
        const { state } = context;
        console.log(`[GatewayIntegrationPlugin] Configuring Gateway at ${this.endpoint}`);

        // 1. Map RouteTable to GatewayConfig
        // We assume Routes in RouteTable are the services we want to register.
        // We use getAllRoutes() to aggregate proxied, internal, external.
        const services = state.getAllRoutes()
            .map(r => r.service) // Extract ServiceDefinition
            // Filter strictly for GraphQL protocols.
            .filter(s => s.endpoint && (s.protocol === 'tcp:graphql' || s.protocol === 'tcp:gql'))
            .map(s => ({
                name: s.name,
                url: s.endpoint!,
                token: undefined
            }));

        const config = { services };

        try {
            await this.sendConfigToGateway(config);
        } catch (error: any) {
            console.error('[GatewayIntegrationPlugin] Failed to update gateway:', error);
            return {
                success: false,
                error: {
                    pluginName: this.name,
                    message: `Gateway update failed: ${error.message}`,
                    error
                }
            };
        }

        return { success: true, ctx: context };
    }

    // Method to send config
    // Method to send config
    async sendConfigToGateway(config: any) {
        // Dynamic import to avoid strict dependency if not configured? No, we have it in package.json
        const { newWebSocketRpcSession } = await import('capnweb');
        // Import type only for compilation safety is done at top level usually, 
        // but here we are in a monorepo so we can assume we can import the type.

        console.log(`[GatewayIntegrationPlugin] Connecting to ${this.endpoint}...`);

        try {
            // newWebSocketRpcSession returns a stub (Proxy) for the remote service
            // We can pass the generic type if we had it, but for dynamic/loose typing here:
            const gateway = newWebSocketRpcSession(this.endpoint);

            // Invoke the method. newWebSocketRpcSession manages the connection.
            // Note: It might not throw on connection failure immediately until a call is made?
            // Or typically it tries to connect.

            // @ts-ignore - Dynamic usage or loose typing to match remote method
            const resultPromise = gateway.updateConfig(config);
            const result = await resultPromise;

            if (!result.success) {
                throw new Error(result.error);
            }

            console.log('[GatewayIntegrationPlugin] Gateway configuration updated successfully.');

            // The session might stay open. We don't have an explicit close on the stub itself easily 
            // without accessing hidden session state or if capnweb exports session helper.
            // For now, let it be cleaned up or persisted.

        } catch (error: any) {
            console.error('[GatewayIntegrationPlugin] RPC Error:', error);
            throw error;
        }
    }
}
