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
import { InternalBGPPlugin } from '../plugins/implementations/Internal-bgp.js';
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
        const internalBgpPlugin = new InternalBGPPlugin();

        this.pipeline = new PluginPipeline([routingPlugin, internalBgpPlugin, ...plugins], 'OrchestratorPipeline');
    }

    async connectionFromManagementSDK(): Promise<ManagementScope> {
        return {
            applyAction: (action) => this.applyAction(action),
            listLocalRoutes: () => this.listLocalRoutes(),
            listMetrics: () => this.listMetrics(),
            listPeers: () => this.listPeers()
        };
    }

    async connectionFromIBGPPeer(secret: string): Promise<IBGPScope> {
        const config = getConfig();
        if (secret !== config.peering.secret) {
            throw new Error('Invalid secret');
        }

        let connectedPeerId: string | undefined;

        return {
            open: async (peerInfo: PeerInfo) => {
                console.log(`[iBGP] Peer connected: ${peerInfo.id} (AS ${peerInfo.as})`);
                connectedPeerId = peerInfo.id;

                // If new, register via pipeline
                // The plugin will handle the reverse connection
                const action: Action = {
                    resource: 'internalPeerSession',
                    resourceAction: 'open',
                    data: {
                        peerInfo,
                        clientStub: null,
                        direction: 'inbound'
                    }
                };

                return await this.applyAction(action);
            },
            update: async (routes: any) => {
                const action: Action = {
                    resource: 'internalBGPRoute',
                    resourceAction: 'update',
                    data: {
                        ...routes,
                        sourcePeerId: connectedPeerId
                    }
                };

                return this.applyAction(action);
            },
            close: async () => {
                const action: Action = {
                    resource: 'internalPeerSession',
                    resourceAction: 'close',
                    data: {
                        peerId: connectedPeerId || 'unknown',
                        skipNotify: true
                    }
                };

                return this.applyAction(action);
            }
        };
    }

    private actionLock: Promise<any> = Promise.resolve();

    async applyAction(action: Action): Promise<ApplyActionResult> {
        const resultPromise = this.actionLock.then(async () => {
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
        });

        this.actionLock = resultPromise.catch(() => { }); // Continue chain even on error
        return resultPromise;
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

export interface ManagementScope {
    applyAction(action: Action): Promise<ApplyActionResult>;
    listLocalRoutes(): Promise<ListLocalRoutesResult>;
    listMetrics(): Promise<ListMetricsResult>;
    listPeers(): Promise<ListPeersResult>;
}

export interface PeerInfo {
    id: string;
    as: number;
    domains: string[];
    services: any[];
}

export interface IBGPScope {
    open(peerInfo: PeerInfo): Promise<ApplyActionResult>;
    update(routes: any): Promise<ApplyActionResult>;
    close(): Promise<ApplyActionResult>;
}
