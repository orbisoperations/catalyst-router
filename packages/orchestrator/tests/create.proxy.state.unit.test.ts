
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import type { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('Proxy State - Create', () => {
    const service: ServiceDefinition = {
        name: 'test-create-proxy',
        protocol: 'http:graphql',
        endpoint: 'localhost:8081',
        region: 'us-east-1'
    };

    it('should add a proxied route immutably', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addProxiedRoute(service);

        expect(table1.getProxiedRoutes()).toHaveLength(0);
        expect(table2.getProxiedRoutes()).toHaveLength(1);
        expect(table2.getProxiedRoutes()[0].service).toEqual(service);
        expect(id).toBe(`${service.name}:${service.protocol}`);

        // Correct bucket check
        expect(table2.getInternalRoutes()).toHaveLength(0);
        expect(table2.getExternalRoutes()).toHaveLength(0);
    });
});
