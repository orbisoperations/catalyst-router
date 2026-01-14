
import { describe, it, expect, beforeEach } from 'bun:test';
import { LocalRoutingTablePlugin } from '../src/plugins/implementations/local-routing.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';
import { DataChannel } from '../src/types.js';

describe('LocalRoutingTablePlugin Comprehensive Tests', () => {
    let plugin: LocalRoutingTablePlugin;
    let state: RouteTable;

    beforeEach(() => {
        plugin = new LocalRoutingTablePlugin();
        state = new RouteTable();
    });

    // Helper to create context
    const createCtx = (resource: string, data: any): PluginContext => ({
        action: { resource, data },
        state,
        authxContext: {} as any
    });

    describe('Create Actions', () => {
        it('should correctly create an internal route', async () => {
            const data: DataChannel = {
                name: 'internal-service-1',
                endpoint: 'tcp://10.0.0.1:8080',
                protocol: 'tcp',
                region: 'us-east-1'
            };
            const ctx = createCtx('create-datachannel:local-routing', data);

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
            const internalRoutes = ctx.state.getInternalRoutes();
            expect(internalRoutes).toHaveLength(1);
            expect(internalRoutes[0].service).toEqual(data);
            expect(ctx.state.getProxiedRoutes()).toHaveLength(0);
        });

        it('should correctly create a proxy route', async () => {
            const data: DataChannel = {
                name: 'proxy-service-1',
                endpoint: 'http://proxy.target',
                protocol: 'tcp:graphql',
                region: 'us-west-1'
            };
            const ctx = createCtx('create-datachannel:local-routing', data);

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
            const proxiedRoutes = ctx.state.getProxiedRoutes();
            expect(proxiedRoutes).toHaveLength(1);
            expect(proxiedRoutes[0].service).toEqual(data);
            expect(ctx.state.getInternalRoutes()).toHaveLength(0);
        });
    });

    describe('Update Actions', () => {
        it('should update an existing internal route', async () => {
            // Setup initial state
            const initialData: DataChannel = {
                name: 'internal-service-update',
                endpoint: 'tcp://old:8080',
                protocol: 'tcp'
            };
            // Update the state variable with the new state ensuring it has the route
            const { state: stateWithRoute } = state.addInternalRoute(initialData);
            state = stateWithRoute;

            // Update action
            const updateData: DataChannel = {
                name: 'internal-service-update',
                endpoint: 'tcp://new:9090',
                protocol: 'tcp',
                region: 'updated-region'
            };
            // createCtx uses the updated 'state'
            const ctx = createCtx('update-datachannel:local-routing', updateData);

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
            // Verify on the NEW state returned in context
            const route = ctx.state.getInternalRoutes().find(r => r.service.name === 'internal-service-update');
            expect(route).toBeDefined();
            expect(route?.service.endpoint).toBe('tcp://new:9090');
            expect(route?.service.region).toBe('updated-region');
        });

        it('should fail to update non-existent internal route', async () => {
            const updateData: DataChannel = {
                name: 'non-existent',
                endpoint: 'tcp://new:9090',
                protocol: 'tcp'
            };
            const ctx = createCtx('update-datachannel:local-routing', updateData);

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(false);
            if (!result.success) { // Type guard
                expect(result.error.message).toContain('Internal route not found');
            }
        });

        it('should update an existing proxy route', async () => {
            // Setup
            const initialData: DataChannel = {
                name: 'proxy-service-update',
                endpoint: 'http://old.proxy',
                protocol: 'tcp:graphql'
            };
            const { state: stateWithRoute } = state.addProxiedRoute(initialData);
            state = stateWithRoute;

            // Update
            const updateData: DataChannel = {
                name: 'proxy-service-update',
                endpoint: 'http://new.proxy',
                protocol: 'tcp:graphql'
            };
            const ctx = createCtx('update-datachannel:local-routing', updateData);

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
            const route = ctx.state.getProxiedRoutes().find(r => r.service.name === 'proxy-service-update');
            expect(route?.service.endpoint).toBe('http://new.proxy');
        });
    });

    describe('Delete Actions', () => {
        it('should delete an existing route', async () => {
            // Setup
            const data: DataChannel = {
                name: 'to-delete',
                endpoint: 'tcp://host:port',
                protocol: 'tcp'
            };
            const { state: stateWithRoute, id } = state.addInternalRoute(data);
            state = stateWithRoute;

            const ctx = createCtx('delete-datachannel:local-routing', { id });

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
            expect(ctx.state.getInternalRoutes()).toHaveLength(0);
        });

        it('should handle deleting non-existent route gracefully (idempotent)', async () => {
            const ctx = createCtx('delete-datachannel:local-routing', { id: 'missing-id' });

            const result = await plugin.apply(ctx);

            expect(result.success).toBe(true);
        });
    });
});
