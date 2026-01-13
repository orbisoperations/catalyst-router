
import { describe, it, expect } from 'bun:test';
import { TestNode } from './mock-transport.js';

describe('Topology Case 3: Star Peering (A -> B <- C)', () => {
    // In this scenario, B is the "Hub". A and C are "Spokes".
    // Both A and C initiate connection to B.
    // A route added on A should traverse B and reach C.
    // A route added on C should traverse B and reach A.

    it('should exchange routes between spokes via hub', async () => {
        const nodeA = new TestNode('node-a', 100);
        const nodeB = new TestNode('node-b', 100); // Hub
        const nodeC = new TestNode('node-c', 100);

        // A Connects to B
        await nodeA.connectTo(nodeB);
        // C Connects to B
        await nodeC.connectTo(nodeB);

        // A adds a route
        const routeA = {
            name: 'service-a',
            fqdn: 'service-a.internal',
            endpoint: 'http://a',
            protocol: 'tcp:http' as const
        };
        const resA = nodeA.routeTable.addInternalRoute(routeA);
        nodeA.routeTable = resA.state;
        // Broadcast
        for (const p of nodeA.routeTable.getPeers()) {
            p.sendUpdate({ type: 'add', route: routeA } as any);
        }

        // Wait for propagation
        // A -> B -> C
        await new Promise(resolve => setTimeout(resolve, 50));

        // B should have it
        const routesB = nodeB.routeTable.getAllRoutes();
        expect(routesB.find(r => r.id === routeA.fqdn)).toBeDefined();

        // C should have it (Reflected by B)
        const routesC = nodeC.routeTable.getAllRoutes();
        expect(routesC.find(r => r.id === routeA.fqdn)).toBeDefined();
        // Source on C should be B (the peer it learned from), or maybe we track original source?
        // Current implementation tracks "sourcePeerId" as the immediate peer we learned from.
        // So for C, source is B.
        const receivedRouteA = routesC.find(r => r.id === routeA.fqdn);
        expect(receivedRouteA?.sourcePeerId).toBe('node-b');

        // Now C adds a route
        const routeC = {
            name: 'service-c',
            fqdn: 'service-c.internal',
            endpoint: 'http://c',
            protocol: 'tcp:http' as const
        };
        const resC = nodeC.routeTable.addInternalRoute(routeC);
        nodeC.routeTable = resC.state;
        // Broadcast
        for (const p of nodeC.routeTable.getPeers()) {
            p.sendUpdate({ type: 'add', route: routeC } as any);
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        // A should get it via B
        const routesA = nodeA.routeTable.getAllRoutes();
        expect(routesA.find(r => r.id === routeC.fqdn)).toBeDefined();
    });
});
