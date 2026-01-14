
import { RpcTarget } from 'capnweb';
import {
    Action,
    AddDataChannelResult,
    ListLocalRoutesResult,
    ListMetricsResult,
} from './schema/index.js';
import { GlobalRouteTable } from '../state/route-table.js';
import { PluginPipeline } from '../plugins/pipeline.js';
import { AuthPlugin } from '../plugins/implementations/auth.js';
import { LoggerPlugin } from '../plugins/implementations/logger.js';
// import { StatePersistencePlugin } from '../plugins/implementations/state.js';
import { RouteTablePlugin } from '../plugins/implementations/routing.js';
// import { RouteAnnouncerPlugin } from '../plugins/implementations/announcer.js';
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js';
import { DirectProxyRouteTablePlugin } from '../plugins/implementations/proxy-route.js';
import { getConfig } from '../config.js';
import { AuthClient, type IAuthClient } from '../clients/auth.js';

export class OrchestratorRpcServer extends RpcTarget {
    private pipeline: PluginPipeline;
    private authClient: IAuthClient | null = null;

    constructor() {
        super();
        const config = getConfig();

        // Initialize Plugins
        const plugins: any[] = [];

        // Conditionally add Auth Plugin
        if (config.authConfig) {
            this.authClient = new AuthClient(config.authConfig.endpoint);
            plugins.push(new AuthPlugin(this.authClient));
        }

        plugins.push(
            new LoggerPlugin(),
            // new StatePersistencePlugin(),
            new RouteTablePlugin(),
            new DirectProxyRouteTablePlugin(),
            // new RouteAnnouncerPlugin(),
        );

        // Conditionally add Gateway Plugin
        if (config.gqlGatewayConfig) {
            plugins.push(new GatewayIntegrationPlugin({
                gatewayEndpoint: config.gqlGatewayConfig.endpoint,
                authJwksUrl: config.authConfig?.jwksUrl,
            }));
        }

        this.pipeline = new PluginPipeline(plugins);
    }

    shutdown(): void {
        this.authClient?.close();
    }

    async applyAction(request: { action: Action; authToken?: string }): Promise<AddDataChannelResult> {
        try {
            const result = await this.pipeline.apply({
                action: request.action,
                state: GlobalRouteTable,
                authxContext: {},
                authToken: request.authToken,
            } as any); // authToken is handled by AuthPlugin

            if (!result.success) {
                return { success: false, error: result.error.message };
            }

            return {
                success: true,
                id: result.ctx.result?.id
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }


    async listLocalRoutes(): Promise<ListLocalRoutesResult> {
        const routes = GlobalRouteTable.getRoutes();
        return { routes };
    }

    async listMetrics(): Promise<ListMetricsResult> {
        const metrics = GlobalRouteTable.getMetrics();
        return { metrics };
    }
}
