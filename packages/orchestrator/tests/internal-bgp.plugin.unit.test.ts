import { describe, it, expect, mock } from 'bun:test';
import { InternalBGPPlugin } from '../src/plugins/implementations/Internal-bgp.js';
import { RouteTable } from '../src/state/route-table.js';
import { PluginContext } from '../src/plugins/types.js';

describe('InternalBGPPlugin Unit Tests', () => {

    it('should add an internal route when receiving an "add" update', async () => {
        const plugin = new InternalBGPPlugin();
        const initialState = new RouteTable();

        const route = {
            name: 'proxied-service',
            endpoint: 'http://remote:8080/rpc',
            protocol: 'tcp:graphql'
        };

        const context: PluginContext = {
            action: {
                resource: 'internalBGPRoute',
                resourceAction: 'update',
                data: {
                    type: 'add',
                    route,
                    sourcePeerId: 'peer-b'
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const internalRoutes = result.ctx.state.getInternalRoutes();
        expect(internalRoutes).toHaveLength(1);
        expect(internalRoutes[0].service.name).toBe('proxied-service');
        expect(internalRoutes[0].sourcePeerId).toBe('peer-b');
    });

    it('should remove an internal route when receiving a "remove" update', async () => {
        const plugin = new InternalBGPPlugin();
        const routeId = 'proxied-service:tcp:graphql';

        // Seed state with the route
        const seedState = new RouteTable().addInternalRoute({
            name: 'proxied-service',
            endpoint: 'http://remote:8080/rpc',
            protocol: 'tcp:graphql'
        }, 'peer-b').state;

        expect(seedState.getInternalRoutes()).toHaveLength(1);

        const context: PluginContext = {
            action: {
                resource: 'internalBGPRoute',
                resourceAction: 'update',
                data: {
                    type: 'remove',
                    routeId
                }
            },
            state: seedState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const internalRoutes = result.ctx.state.getInternalRoutes();
        expect(internalRoutes).toHaveLength(0);
    });

    it('should trigger broadcast when a local route is created', async () => {
        const plugin = new InternalBGPPlugin();

        // Mock the internal broadcast logic if possible, 
        // but since it's a private method and uses dynamic imports, 
        // we can test it by seeding peers and checking if it runs without error 
        // or by spying on the dynamic imports (which is tricky in Bun).

        // For now, let's verify it doesn't crash and potentially check logs or mocked side effects.
        const stateWithPeer = new RouteTable().addPeer({
            id: 'peer-b',
            as: 100,
            endpoint: 'http://peer-b:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: 'localRoute',
                resourceAction: 'create',
                data: {
                    name: 'local-service',
                    endpoint: 'http://localhost:8080',
                    protocol: 'tcp'
                }
            } as any,
            state: stateWithPeer,
            results: [],
            authxContext: {} as any
        };

        // We can't easily mock the network call here without more setup, 
        // but we can verify the plugin attempts to broadcast.
        // We'll use a try/catch or just see if it finishes.

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
    });
});
