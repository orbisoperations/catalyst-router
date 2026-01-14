
import { describe, it, expect } from 'bun:test';
import { LocalRoutingTablePlugin } from '../src/plugins/implementations/local-routing.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

describe('LocalRoutingTablePlugin Tests', () => {
    it('should add route to proxiedRoutes map on create action for proxy protocol', async () => {
        const plugin = new LocalRoutingTablePlugin();
        const state = new RouteTable();
        const context: PluginContext = {
            action: {
                resource: 'local-routing',
                action: 'create-datachannel',
                data: {
                    name: 'test-proxy-service',
                    endpoint: 'http://proxy-target',
                    protocol: 'tcp:graphql',
                    region: 'us-west'
                }
            },
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);

        expect(result.success).toBe(true);
        // Typescript issue with result.ctx not being guaranteed in PluginResult? 
        // BasePlugin usually returns { success: true, ctx: context }
        // Let's assume context.state is mutated
        const newState = context.state;
        const proxied = newState.getProxiedRoutes();
        expect(proxied).toHaveLength(1);
        expect(proxied[0].service.name).toBe('test-proxy-service');
        expect(proxied[0].service.endpoint).toBe('http://proxy-target');

        // Ensure it didn't leak to internal
        expect(newState.getInternalRoutes()).toHaveLength(0);
    });

    it('should add route to internalRoutes map on create action for internal protocol', async () => {
        const plugin = new LocalRoutingTablePlugin();
        const state = new RouteTable();
        const context: PluginContext = {
            action: {
                resource: 'local-routing',
                action: 'create-datachannel',
                data: {
                    name: 'test-internal-service',
                    endpoint: 'tcp://localhost:9090',
                    protocol: 'tcp',
                    region: 'us-west'
                }
            },
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);

        expect(result.success).toBe(true);
        const newState = context.state;
        const internal = newState.getInternalRoutes();
        expect(internal).toHaveLength(1);
        expect(internal[0].service.name).toBe('test-internal-service');

        // Ensure it didn't leak to proxied
        expect(newState.getProxiedRoutes()).toHaveLength(0);
    });

    it('should ignore non-local-routing actions', async () => {
        const plugin = new LocalRoutingTablePlugin();
        const state = new RouteTable();
        const context: PluginContext = {
            action: { resource: 'unknown', action: 'create', data: {} } as any,
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        expect(state.getAllRoutes()).toHaveLength(0);
    });
});
