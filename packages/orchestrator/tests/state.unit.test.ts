
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';
import { ServiceDefinition } from '../src/rpc/schema/index.js';

describe('RouteTable', () => {
    const service: ServiceDefinition = {
        name: 'test-service',
        fqdn: 'test.svc',
        protocol: 'tcp:http',
        endpoint: 'localhost:8080',
        region: 'us-west-1'
    };

    it('should be immutable on addInternalRoute', () => {
        const table1 = new RouteTable();
        const { state: table2, id } = table1.addInternalRoute(service);

        expect(table1.getRoutes()).toHaveLength(0);
        expect(table2.getRoutes()).toHaveLength(1);
        expect(table2.getInternalRoutes()[0].service).toEqual(service);
        expect(id).toBe(service.fqdn);
    });

    it('should be immutable on addProxiedRoute', () => {
        const table1 = new RouteTable();
        const { state: table2 } = table1.addProxiedRoute(service);

        expect(table1.getRoutes()).toHaveLength(0);
        expect(table2.getRoutes()).toHaveLength(1);
        expect(table2.getProxiedRoutes()[0].service).toEqual(service);
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
    it('should aggregate all routes correctly', () => {
        const t1 = new RouteTable();
        const { state: t2 } = t1.addInternalRoute({ name: 'r1', fqdn: 'r1.svc', endpoint: '...', protocol: 'tcp:http' });
        const { state: t3 } = t2.addProxiedRoute({ name: 'r2', fqdn: 'r2.svc', endpoint: '...', protocol: 'tcp:http' });

        expect(t3.getRoutes()).toHaveLength(2);
    });

    it('should remove routes from any category', () => {
        const t1 = new RouteTable();
        const { state: t2, id: id1 } = t1.addInternalRoute({ name: 'internal', fqdn: 'int.svc', endpoint: '...', protocol: 'tcp:http' });
        const { state: t3, id: id2 } = t2.addProxiedRoute({ name: 'proxied', fqdn: 'proxy.svc', endpoint: '...', protocol: 'tcp:http' });

        const t4 = t3.removeRoute(id1);
        expect(t4.getRoutes()).toHaveLength(1);
        expect(t4.getInternalRoutes()).toHaveLength(0);

        const t5 = t4.removeRoute(id2);
        expect(t5.getRoutes()).toHaveLength(0);
    });
});
