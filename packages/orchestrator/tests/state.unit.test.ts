
import { describe, it, expect } from 'bun:test';
import { RouteTable } from '../src/state/route-table.js';

describe('RouteTable Unit Tests', () => {
    it('should add internal routes and retrieve them', () => {
        const state = new RouteTable();
        const id = state.addInternalRoute({
            name: 'internal-service',
            endpoint: 'http://internal',
            protocol: 'http'
        });

        expect(state.getInternalRoutes()).toHaveLength(1);
        expect(state.getInternalRoutes()[0].id).toBe(id);
        // Should also be in all routes
        expect(state.getAllRoutes()).toHaveLength(1);
        // Should NOT be in proxied or external
        expect(state.getProxiedRoutes()).toHaveLength(0);
        expect(state.getExternalRoutes()).toHaveLength(0);
    });

    it('should add proxied routes and retrieve them', () => {
        const state = new RouteTable();
        const id = state.addProxiedRoute({
            name: 'proxied-service',
            endpoint: 'http://proxied',
            protocol: 'http'
        });

        expect(state.getProxiedRoutes()).toHaveLength(1);
        expect(state.getProxiedRoutes()[0].id).toBe(id);
        expect(state.getAllRoutes()).toHaveLength(1);
        expect(state.getInternalRoutes()).toHaveLength(0);
    });

    it('should add external routes and retrieve them', () => {
        const state = new RouteTable();
        const id = state.addExternalRoute({
            name: 'external-service',
            endpoint: 'http://external',
            protocol: 'http'
        });

        expect(state.getExternalRoutes()).toHaveLength(1);
        expect(state.getExternalRoutes()[0].id).toBe(id);
    });

    it('should aggregate all routes correctly', () => {
        const state = new RouteTable();
        state.addInternalRoute({ name: 'internal', endpoint: '...', protocol: 'tcp:http' });
        state.addProxiedRoute({ name: 'proxied', endpoint: '...', protocol: 'tcp:http' });
        state.addExternalRoute({ name: 'external', endpoint: '...', protocol: 'tcp:http' });

        expect(state.getAllRoutes()).toHaveLength(3);
        expect(state.getInternalRoutes()).toHaveLength(1);
        expect(state.getProxiedRoutes()).toHaveLength(1);
        expect(state.getExternalRoutes()).toHaveLength(1);
    });

    it('should remove routes from any category', () => {
        const state = new RouteTable();
        const id1 = state.addInternalRoute({ name: 'internal', endpoint: '...', protocol: 'tcp:http' });
        const id2 = state.addProxiedRoute({ name: 'proxied', endpoint: '...', protocol: 'tcp:http' });

        state.removeRoute(id1);
        expect(state.getAllRoutes()).toHaveLength(1);
        expect(state.getInternalRoutes()).toHaveLength(0);
        expect(state.getProxiedRoutes()).toHaveLength(1);

        state.removeRoute(id2);
        expect(state.getAllRoutes()).toHaveLength(0);
    });
});
