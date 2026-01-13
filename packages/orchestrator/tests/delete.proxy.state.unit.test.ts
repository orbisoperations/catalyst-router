
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('Proxy State - Delete', () => {
    const service: ServiceDefinition = {
        name: 'test-delete-proxy',
        protocol: 'tcp:graphql',
        endpoint: 'localhost:8083',
        region: 'eu-west-1'
    };

    it('should remove a proxied route immutably', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addProxiedRoute(service);

        const table3 = table2.removeRoute(id);

        expect(table2.getProxiedRoutes()).toHaveLength(1);
        expect(table3.getProxiedRoutes()).toHaveLength(0);
        // Ensure no leftover or phantom routes
        expect(table3.getAllRoutes()).toHaveLength(0);
    });

    it('should be idempotent (no change if id not found) but return self/copy', () => {
        const table1 = new RouteTable();
        const table2 = table1.removeRoute('non-existent:tcp:graphql');

        // Implementation detail: it might return 'this' if no change, checking logic or identity
        // Our logic returns 'this' if no change.
        expect(table2).toBe(table1);
    });
});
