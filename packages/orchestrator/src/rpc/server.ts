import { RpcTarget } from 'capnweb';
import {
    ServiceDefinitionSchema,
    Action,
    AddDataChannelResult,
    ListLocalRoutesResult,
    ListMetricsResult,
    AddDataChannelResultSchema,
    ListLocalRoutesResultSchema,
    ListMetricsResultSchema,
    ApplyActionResult
} from './schema/index.js';
import { GlobalRouteTable, RouteTable } from '../state/route-table.js';
import { PluginPipeline } from '../plugins/pipeline.js';
import { AuthPlugin } from '../plugins/implementations/auth.js';
import { LoggerPlugin } from '../plugins/implementations/logger.js';
import { StatePersistencePlugin } from '../plugins/implementations/state.js';
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js';
import { LocalRoutingTablePlugin } from '../plugins/implementations/local-routing.js';
import { InternalAutonomousSystemPlugin } from '../plugins/implementations/internal-as.js';
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
            // new RouteAnnouncerPlugin(),
            // new InternalPeeringPlugin(this.applyAction.bind(this)),
        ];

        // Conditionally add Gateway Plugin
        if (config.gqlGatewayConfig) {
            plugins.push(new GatewayIntegrationPlugin(config.gqlGatewayConfig, {
                triggerOnResources: [
                    'create-datachannel:local-routing',
                    'update-datachannel:local-routing',
                    'delete-datachannel:local-routing'
                ]
            }));
        }

        // Initialize plugins
        const routingPlugin = new LocalRoutingTablePlugin();
        const internalAsPlugin = new InternalAutonomousSystemPlugin();

        this.pipeline = new PluginPipeline([routingPlugin, internalAsPlugin, ...plugins], 'OrchestratorPipeline');
    }

    async applyAction(action: Action): Promise<ApplyActionResult> {
        try {
            const result = await this.pipeline.apply({
                action,
                state: this.state,
                authxContext: { userId: 'stub-user', roles: ['admin'] }, // Stub auth context
                results: []
            });

            if (!result.success) {
                return { success: false, results: [], error: result.error.message };
            }

            // Update local state with the state returned from the pipeline
            this.state = result.ctx.state;

            return {
                success: true,
                results: result.ctx.results
            };
        } catch (e: any) {
            return { success: false, results: [], error: e.message };
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

    async listPeers(): Promise<ListPeersResult> {
        const peers = this.state.getPeers();
        return { peers };
    }
}
