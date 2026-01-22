
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('Proxy State - Composite Lifecycle', () => {
    const service: ServiceDefinition = {
        name: 'test-composite-proxy',
        protocol: 'http:graphql',
        endpoint: 'initial-endpoint',
        region: 'ap-south-1'
    };

    it('should handle create -> update -> delete sequence correctly', () => {
        let state = new RouteTable();

        // 1. Create
        const createRes = state.addProxiedRoute(service);
        state = createRes.state;
        const id = createRes.id;

        expect(state.getProxiedRoutes()).toHaveLength(1);
        expect(state.getProxiedRoutes()[0].service.endpoint).toBe('initial-endpoint');

        // 2. Update
        const updatedService = { ...service, endpoint: 'updated-endpoint' };
        const updateRes = state.updateProxiedRoute(updatedService);
        expect(updateRes).not.toBeNull();
        state = updateRes!.state;

        expect(state.getProxiedRoutes()).toHaveLength(1);
        expect(state.getProxiedRoutes()[0].service.endpoint).toBe('updated-endpoint');

        // 3. Delete
        state = state.removeRoute(id);

        expect(state.getProxiedRoutes()).toHaveLength(0);
    });
});
