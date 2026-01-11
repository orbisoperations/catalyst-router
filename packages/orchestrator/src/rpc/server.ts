
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
import { GlobalRouteTable } from '../state/route-table.js';
import { PluginPipeline } from '../plugins/pipeline.js';
import { AuthPlugin } from '../plugins/implementations/auth.js';
import { LoggerPlugin } from '../plugins/implementations/logger.js';
import { StatePersistencePlugin } from '../plugins/implementations/state.js';
import { RouteTablePlugin } from '../plugins/implementations/routing.js';
import { RouteAnnouncerPlugin } from '../plugins/implementations/announcer.js';
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js';

export class OrchestratorRpcServer extends RpcTarget {
    private pipeline: PluginPipeline;

    constructor() {
        super();
        // Initialize Pipeline
        this.pipeline = new PluginPipeline([
            new AuthPlugin(),
            new LoggerPlugin(),
            new StatePersistencePlugin(),
            new RouteTablePlugin(),
            new RouteAnnouncerPlugin(),
            new GatewayIntegrationPlugin()
        ]);

    }

    async applyAction(action: Action): Promise<AddDataChannelResult> {
        try {
            const result = await this.pipeline.apply({
                action,
                state: GlobalRouteTable,
                authxContext: { userId: 'stub-user', roles: ['admin'] } // Stub auth context
            });

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
