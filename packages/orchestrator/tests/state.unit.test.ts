
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import type { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('RouteTable Unit Tests', () => {
    const service: ServiceDefinition = {
        name: 'test-service',
        protocol: 'http',
        endpoint: 'localhost:8080',
        region: 'us-west-1'
    };

    it('should add internal routes and retrieve them', () => {
        const state = new RouteTable();
        const { state: newState } = state.addInternalRoute({
            name: 'internal-service',
            endpoint: 'http://internal',
            protocol: 'http'
        });

        expect(newState.getInternalRoutes()).toHaveLength(1);
        expect(newState.getInternalRoutes()[0].service.name).toBe('internal-service');
        // Ensure immutability
        expect(state.getInternalRoutes()).toHaveLength(0);
    });

    it('should be immutable on addInternalRoute', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addInternalRoute(service);

        expect(table1.getRoutes()).toHaveLength(0);
        expect(table2.getRoutes()).toHaveLength(1);
        expect(table2.getInternalRoutes()[0].service).toEqual(service);
        expect(id).toBe(`${service.name}:${service.protocol}`);
    });

    it('should add proxied routes and retrieve them', () => {
        const state = new RouteTable();
        const { state: newState } = state.addProxiedRoute({
            name: 'proxied-service',
            endpoint: 'http://proxied',
            protocol: 'http'
        });

        expect(state.getRoutes()).toHaveLength(0);
        expect(newState.getProxiedRoutes()).toHaveLength(1);
        expect(newState.getProxiedRoutes()[0].service.name).toBe('proxied-service');
    });

    it('should add external routes and retrieve them', () => {
        const state = new RouteTable();
        const { state: newState } = state.addExternalRoute({
            name: 'external-service',
            endpoint: 'http://external',
            protocol: 'http'
        });

        expect(state.getRoutes()).toHaveLength(0);
        expect(newState.getExternalRoutes()).toHaveLength(1);
        expect(newState.getExternalRoutes()[0].service.name).toBe('external-service');
    });

    it('should be immutable on updateRoute', () => {
        const table1 = new RouteTable();
        const { state: table2 } = table1.addInternalRoute(service);

        const updatedService = { ...service, endpoint: 'localhost:9090' };
        const result = table2.updateInternalRoute(updatedService);

        expect(result).not.toBeNull();
        const { state: table3 } = result!;

        expect(table2.getInternalRoutes()[0].service.endpoint).toBe('localhost:8080');
        expect(table3.getInternalRoutes()[0].service.endpoint).toBe('localhost:9090');
    });

    it('should be immutable on removeRoute', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addInternalRoute(service);

        const table3 = table2.removeRoute(id);

        expect(table2.getRoutes()).toHaveLength(1);
        expect(table3.getRoutes()).toHaveLength(0);
    });

    it('should handle metrics immutability', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addInternalRoute(service);

        const table3 = table2.recordConnection(id);

        expect(table2.getMetrics()[0].connectionCount).toBe(0);
        expect(table3.getMetrics()[0].connectionCount).toBe(1);
    });
});
