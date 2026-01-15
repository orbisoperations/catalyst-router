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
// import { InternalAutonomousSystemPlugin } from '../peering/plugins/InternalAutonomousSystem.js';
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
                    'localRoute'
                ]
            }));
        }

        // Initialize plugins
        const routingPlugin = new LocalRoutingTablePlugin();
        // const internalAsPlugin = new InternalAutonomousSystemPlugin();

        // this.pipeline = new PluginPipeline([routingPlugin, internalAsPlugin, ...plugins], 'OrchestratorPipeline');
        this.pipeline = new PluginPipeline([routingPlugin, ...plugins], 'OrchestratorPipeline');
    }

    async connectionFromCli(): Promise<CliScope> {
        return {
            applyAction: (action) => this.applyAction(action),
            listLocalRoutes: () => this.listLocalRoutes(),
            listMetrics: () => this.listMetrics()
        };
    }

    async connectionFromIBGPPeer(secret: string): Promise<IBGPScope> {
        // TODO: Validate secret against configured peers
        // For now, allow any non-empty secret or match a dummy one
        if (!secret) {
            throw new Error('Invalid secret');
        }

        return {
            open: async (callback) => {
                // Return dummy PeerInfo for now
                return {
                    id: 'local-node',
                    as: 100, // TODO: Get from config
                    domains: [],
                    services: []
                };
            },
            update: async (routes) => {
                // Delegate to applyAction
                // Mapping internal routes to 'updateRoutes' or similar action
                // For now, we just pass the action through if it matches our schema
                // But typically update() takes a RouteTable or list of routes
                // Let's assume the argument 'routes' IS the action payload for now for simplicity
                // or wrap it.
                // Based on diagram: BGP -> IBGPScope: update(...)
                // IBGPScope -> API: applyAction(...)

                // We'll construct the action manually:
                /*
                const action: Action = {
                   resource: 'routeTable', 
                   resourceAction: 'update', 
                   data: routes 
                };
                */
                // Since we don't have the exact types for 'routes' defined yet in this context,
                // and plugins are disabled, we will just return a success stub.
                return { success: true, results: [] };
                // Actual delegation (commented out until types aligned):
                // return this.applyAction({ resource: 'routeTable', action: 'update', data: routes });
            }
        };
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

export interface CliScope {
    applyAction(action: Action): Promise<ApplyActionResult>;
    listLocalRoutes(): Promise<ListLocalRoutesResult>;
    listMetrics(): Promise<ListMetricsResult>;
}

export interface PeerInfo {
    id: string;
    as: number;
    domains: string[];
    services: any[];
}

export interface IBGPScope {
    open(callback: any): Promise<PeerInfo>;
    update(routes: any): Promise<ApplyActionResult>;
}
