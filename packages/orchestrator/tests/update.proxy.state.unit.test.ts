
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import type { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('Proxy State - Update', () => {
    const service: ServiceDefinition = {
        name: 'test-update-proxy',
        protocol: 'tcp:graphql',
        endpoint: 'localhost:8082',
        region: 'us-east-2'
    };

    it('should update a proxied route immutably', () => {
        const table1 = new RouteTable();
        const { state: table2 } = table1.addProxiedRoute(service);

        const updatedService = { ...service, endpoint: 'localhost:9092' };
        const result = table2.updateProxiedRoute(updatedService);

        expect(result).not.toBeNull();
        const { state: table3, id } = result!;

        expect(table2.getProxiedRoutes()[0].service.endpoint).toBe('localhost:8082');
        expect(table3.getProxiedRoutes()).toHaveLength(1);
        expect(table3.getProxiedRoutes()[0].service.endpoint).toBe('localhost:9092');
        expect(id).toBe(`${service.name}:${service.protocol}`);
    });

    it('should return null if route does not exist to update', () => {
        const table1 = new RouteTable();
        const result = table1.updateProxiedRoute(service);
        expect(result).toBeNull();
    });
});
