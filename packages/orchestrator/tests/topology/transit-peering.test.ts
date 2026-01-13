
import { describe, it, expect } from 'bun:test';
import { TestNode } from './mock-transport';

describe('Topology Case 2: Transit Peering (A -> B -> C)', () => {
    it('should propagate routes across multiple hops', async () => {
        // Setup Nodes
        const nodeA = new TestNode('node-a', 100, ['internal']);
        const nodeB = new TestNode('node-b', 100, ['internal']);
        const nodeC = new TestNode('node-c', 100, ['internal']);

        // Connect B to A (A <-> B)
        await nodeB.connectTo(nodeA);

        // Connect B to C (B <-> C)
        await nodeB.connectTo(nodeC);

        // Allow initial connection propagation
        await new Promise(r => setTimeout(r, 10));

        console.log('A Peers:', nodeA.routeTable.getPeers().map(p => p.id));

        // Register Service on A (The Origin)
        const res = nodeA.routeTable.addInternalRoute({
            name: 'service-a',
            fqdn: 'service-a.internal',
            endpoint: 'http://a',
            protocol: 'tcp:http'
        });
        nodeA.routeTable = res.state;

        // Manually broadcast since RouteTable is pure
        const route = res.state.getInternalRoutes().find(r => r.service.name === 'service-a')?.service;
        if (route) {
            const updateMsg = { type: 'add', route };
            for (const p of nodeA.routeTable.getPeers()) {
                p.sendUpdate(updateMsg as any);
            }
        }

        // Current implementation:
        // A broadcasts to B (B is connected peer) -> B receives 'add' from A.
        // B adds to Map.
        // B should RE-broadcast to C because it's a new route (Transit).

        // Allow propagation (A->B->C)
        await new Promise(r => setTimeout(r, 100)); // Increased timeout

        // Debug B state
        const routesBDebug = nodeB.routeTable.getAllRoutes();
        console.log('Routes in B:', JSON.stringify(routesBDebug, null, 2));

        // Verify C knows about service-a
        // This is the CRITICAL Transit Test
        const routesC = nodeC.routeTable.getAllRoutes();
        const routeC = routesC.find(r => r.service.fqdn === 'service-a.internal');

        expect(routeC).toBeDefined();
        if (routeC) {
            // Source for C should be B (the peer it learned from), or do we track Origin?
            // In our current simple implementation, 'sourcePeerId' is the neighbor we learned it from.
            expect(routeC.sourcePeerId).toBe('node-b');
        }

        // Verify B knows about service-a
        const routesB = nodeB.routeTable.getAllRoutes();
        const routeB = routesB.find(r => r.service.fqdn === 'service-a.internal');
        expect(routeB).toBeDefined();
        if (routeB) {
            expect(routeB.sourcePeerId).toBe('node-a');
        }
    });
});
