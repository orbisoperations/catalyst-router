import { RpcTarget } from 'capnweb';
import {
    ServiceDefinitionSchema,
    Action,
    AddDataChannelResult,
    ListLocalRoutesResult,
    ListMetricsResult,
    AddDataChannelResultSchema,
    ListLocalRoutesResultSchema,
    ListMetricsResultSchema
} from './schema/index.js';
import { GlobalRouteTable, RouteTable } from '../state/route-table.js';
import { PluginPipeline } from '../plugins/pipeline.js';
import { AuthPlugin } from '../plugins/implementations/auth.js';
import { LoggerPlugin } from '../plugins/implementations/logger.js';
import { StatePersistencePlugin } from '../plugins/implementations/state.js';
import { InternalRouteTablePlugin } from '../plugins/implementations/internal-routing.js';
import { ExternalRouteTablePlugin } from '../plugins/implementations/external-routing.js';
import { RouteAnnouncerPlugin } from '../plugins/implementations/announcer.js';
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js';
import { DirectProxyRouteTablePlugin } from '../plugins/implementations/proxy-route.js';
import { InternalPeeringPlugin } from '../plugins/implementations/internal-peering.js';
import { PeeringService } from '../peering/service.js';
import { AuthorizedPeer, ListPeersResult } from './schema/peering.js';
import { getConfig, OrchestratorConfig } from '../config.js';

export class OrchestratorRpcServer extends RpcTarget {
    private pipeline: PluginPipeline;
    private state: RouteTable;

    constructor() {
        super();
        const config = getConfig();

        // Initialize State with GlobalRouteTable (empty/initial)
        this.state = GlobalRouteTable;

        // Initialize Plugins
        const plugins: any[] = [
            // new AuthPlugin(),
            new LoggerPlugin(),
            // new StatePersistencePlugin(),
            new InternalRouteTablePlugin(),
            new ExternalRouteTablePlugin(),
            new DirectProxyRouteTablePlugin(),
            // new RouteAnnouncerPlugin(),
            new InternalPeeringPlugin(),
        ];

        // Conditionally add Gateway Plugin
        if (config.gqlGatewayConfig) {
            plugins.push(new GatewayIntegrationPlugin(config.gqlGatewayConfig));
        }

        this.pipeline = new PluginPipeline(plugins);
    }

    async applyAction(action: Action): Promise<AddDataChannelResult> {
        try {
            const result = await this.pipeline.apply({
                action,
                state: this.state,
                authxContext: { userId: 'stub-user', roles: ['admin'] } // Stub auth context
            });

            if (!result.success) {
                return { success: false, error: result.error.message };
            }

            // Update local state with the state returned from the pipeline
            this.state = result.ctx.state;

            return {
                success: true,
                id: result.ctx.result?.['id'] as string | undefined
            };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }


    async listLocalRoutes(): Promise<ListLocalRoutesResult> {
        const routes = this.state.getRoutes();
        return { routes };
    }

    async listMetrics(): Promise<ListMetricsResult> {
        const metrics = this.state.getMetrics();
        return { metrics };
    }

    // ----------------------------------------------------------------
    // Peer Public API Implementation
    // ----------------------------------------------------------------

    authenticate(secret: string): AuthorizedPeer {
        const service = new PeeringService(
            () => this.state,
            (s) => { this.state = s; }
        );
        return service.authenticate(secret);
    }

    async listPeers(): Promise<ListPeersResult> {
        const peers = this.state.getPeers().map(p => ({
            id: p.id,
            as: p.as,
            endpoint: p.address,
            domains: p.domains
        }));
        return { peers };
    }

    async ping(): Promise<string> {
        const service = new PeeringService(
            () => this.state,
            (s) => { this.state = s; }
        );
        return service.ping();
    }
}
