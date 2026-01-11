
import { describe, it, expect } from 'bun:test';
import { DirectProxyRouteTablePlugin } from '../src/plugins/implementations/proxy-route.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

describe('DirectProxyRouteTablePlugin Tests', () => {
    it('should add route to proxiedRoutes map on create action', async () => {
        const plugin = new DirectProxyRouteTablePlugin();
        const state = new RouteTable();
        const context: PluginContext = {
            action: {
                resource: 'dataChannel',
                action: 'create',
                data: {
                    name: 'test-proxy-service',
                    endpoint: 'http://proxy-target',
                    protocol: 'tcp:http',
                    region: 'us-west'
                }
            },
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);

        expect(result.success).toBe(true);
        const proxied = state.getProxiedRoutes();
        expect(proxied).toHaveLength(1);
        expect(proxied[0].service.name).toBe('test-proxy-service');
        expect(proxied[0].service.endpoint).toBe('http://proxy-target');

        // Ensure it didn't leak to internal
        expect(state.getInternalRoutes()).toHaveLength(0);
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
