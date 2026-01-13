
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { DirectProxyRouteTablePlugin } from '../src/plugins/implementations/proxy-route.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

describe('DirectProxyRouteTablePlugin Tests', () => {
    // Mock environment
    const originalEnv = process.env;

    beforeAll(() => {
        process.env.CATALYST_DOMAINS = 'test.svc,us-west.svc';
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('should add route to proxiedRoutes map on create action', async () => {
        const plugin = new DirectProxyRouteTablePlugin();
        const state = new RouteTable();
        const serviceDef = {
            name: 'test-service',
            fqdn: 'test.svc',
            endpoint: 'http://localhost:3000',
            protocol: 'tcp:graphql' as const, // Must match plugin filter
            region: 'us-west'
        };
        const context: PluginContext = {
            action: {
                resource: 'dataChannel',
                action: 'create',
                data: serviceDef
            },
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);

        if (!result.success) {
            throw new Error(JSON.stringify(result.error));
        }
        const newState = result.ctx.state;
        const proxied = newState.getProxiedRoutes();
        expect(proxied).toHaveLength(1);
        expect(proxied[0].service.name).toBe('test-service');
        expect(proxied[0].service.endpoint).toBe('http://localhost:3000');

        // Ensure it didn't leak to internal
        expect(newState.getInternalRoutes()).toHaveLength(0);
    });

    it('should ignore non-dataChannel actions', async () => {
        const plugin = new DirectProxyRouteTablePlugin();
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
