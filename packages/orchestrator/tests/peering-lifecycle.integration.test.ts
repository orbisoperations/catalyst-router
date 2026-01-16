
import { describe, it, expect } from 'bun:test';
import { OrchestratorRpcServer } from '../src/rpc/server.js';
import { RouteTable } from '../src/state/route-table.js';
import { AuthorizedPeer } from '../src/rpc/schema/peering.js';
import { mock } from 'bun:test';

const mockSessions: any[] = [];

mock.module('../src/rpc/client.js', () => ({
    getHttpPeerSession: () => {
        const session = {
            open: mock(async () => ({
                success: true,
                peerInfo: {
                    id: 'mock-peer-id',
                    as: 100,
                    endpoint: 'http://mock-endpoint',
                    domains: []
                }
            })),
            update: mock(async () => ({ success: true })),
            close: mock(async () => ({ success: true }))
        };
        mockSessions.push(session);
        return session;
    }
}));

describe('Peering Status & Lifecycle (Mocked)', () => {

    // We mock the server environment by instantiating the RPC server 
    // and driving it via actions, similar to how the CLI would.

    it('should list peers after connection and remove them after disconnect', async () => {
        const server = new OrchestratorRpcServer();

        // 1. Initial State: No peers
        const initialPeers = await server.listPeers();
        expect(initialPeers.peers).toHaveLength(0);

        // 2. Add a Peer (Simulate 'create peer' action)
        // This simulates the CLI 'peer add' command dispatching an action
        const addPeerAction = {
            resource: 'internalBGPConfig',
            resourceAction: 'create',
            data: {
                endpoint: 'ws://mock-peer-endpoint',
                secret: 'mock-secret'
            }
        };

        // Note: The 'InternalAutonomousSystemPlugin' logic currently attempts to CONNECT via WebSocket.
        // Since we don't have a real WS server, it will fail and return error, OR 
        // we can Mock the 'capnweb' import or the specific logic using Bun.mock?
        // Since we can't easily Bun.mock module internals from here without setup, 
        // we might stick to testing the "Open" action which registers the peer.
        // The "Create" action initiates outbound. The "Open" action is the finalization.
        // Let's test the "Registered" state coming from a successful handshake (OPEN).

        const openAction = {
            resource: 'internalBGP',
            resourceAction: 'open',
            data: {
                peerInfo: { id: 'peer-node-1', as: 200, endpoint: 'ws://peer-1', domains: ['d1'] }
            }
        };

        const result = await server.applyAction(openAction as any);
        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(0);

        // 3. Verify List Peers finds it
        const connectedPeers = await server.listPeers();
        expect(connectedPeers.peers).toHaveLength(1);
        expect(connectedPeers.peers[0].id).toBe('peer-node-1');
        expect(connectedPeers.peers[0].as).toBe(200);

        // 4. Disconnect (Simulate 'close' action)
        const closeAction = {
            resource: 'internalBGP',
            resourceAction: 'close',
            data: {
                peerInfo: { id: 'peer-node-1', as: 200, endpoint: 'ws://peer-1' }
            }
        };

        const closeResult = await server.applyAction(closeAction as any);
        expect(closeResult.success).toBe(true);

        // 5. Verify Peer Removed
        const disconnectedPeers = await server.listPeers();
        expect(disconnectedPeers.peers).toHaveLength(0);
    });

    it('should remove routes associated with a peer on disconnect', async () => {
        const server = new OrchestratorRpcServer();

        // 1. Add Peer
        const peerId = 'peer-with-routes';
        await server.applyAction({
            resource: 'internalBGP',
            resourceAction: 'open',
            data: {
                peerInfo: { id: peerId, as: 300, endpoint: 'ws://p2', domains: [] }
            }
        } as any);

        // 2. Add Route from that Peer via BGP Update action
        // Note: The plugin now supports 'internalBGPRoute/update'
        const serviceName = 'service-from-peer';
        await server.applyAction({
            resource: 'internalBGP',
            resourceAction: 'update',
            data: {
                peerInfo: { id: peerId, as: 300, endpoint: 'ws://p2', domains: [] },
                updateMessages: [
                    {
                        type: 'add',
                        route: {
                            name: serviceName,
                            endpoint: 'http://peer-endpoint',
                            protocol: 'tcp'
                        }
                    }
                ]
            }
        } as any);

        // 3. Verify Route Exists
        const routesAfterAdd = await server.listLocalRoutes();
        const peerRoute = routesAfterAdd.routes.find(r => r.service.name === serviceName);
        expect(peerRoute).toBeDefined();
        expect(peerRoute?.sourcePeerId).toBe(peerId);

        // 4. Disconnect Peer
        await server.applyAction({
            resource: 'internalBGP',
            resourceAction: 'close',
            data: {
                peerInfo: { id: peerId, as: 300, endpoint: 'ws://p2' }
            }
        } as any);

        // 5. Verify Route Removed
        const routesAfterDisconnect = await server.listLocalRoutes();
        const routeGone = routesAfterDisconnect.routes.find(r => r.service.name === serviceName);
        expect(routeGone).toBeUndefined();
    });

    it('should broadcast local route updates to connected peers', async () => {
        const server = new OrchestratorRpcServer();
        mockSessions.length = 0; // Clear mocks

        // 2. Add Peer
        await server.applyAction({
            resource: 'internalBGP',
            resourceAction: 'open',
            data: {
                peerInfo: { id: 'listener-peer', as: 400, endpoint: 'ws://p3', domains: [] }
            }
        } as any);

        // 3. Create a Local Route (simulating Service Add)
        const serviceName = 'propagated-service';
        await server.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: serviceName,
                endpoint: 'http://local:3000',
                protocol: 'tcp'
            }
        } as any);

        // 4. Verify peer received UPDATE
        // The last session created should be the one for 'listener-peer' (during open)
        // Actually, sendIndividualUpdate creates a NEW session each time currently (or factory usage).
        // Wait for async broadcast
        await new Promise(r => setTimeout(r, 10));

        // Find calls to update
        const updateCalls = mockSessions.flatMap(s => s.update.mock.calls);
        const lastCallArgs = updateCalls[updateCalls.length - 1]; // [myPeerInfo, updates]

        expect(lastCallArgs).toBeDefined();
        const updates = lastCallArgs[1];
        expect(updates).toHaveLength(1);
        expect(updates[0].type).toBe('add');
        expect(updates[0].route.name).toBe(serviceName);

        // 5. Delete Local Route
        // Find ID first (mocking ID knowledge or implementation detail)
        // Since create action usually returns ID but here we are using mocked server applyAction which returns generic result.
        // We know the route plugin generates ID as `${name}:${protocol}`.
        const routeId = `${serviceName}:tcp`;

        await server.applyAction({
            resource: 'localRoute',
            resourceAction: 'delete',
            data: { id: routeId }
        } as any);

        // 6. Verify peer received withdrawal
        await new Promise(r => setTimeout(r, 10));

        const updateCalls2 = mockSessions.flatMap(s => s.update.mock.calls);
        const lastCallArgs2 = updateCalls2[updateCalls2.length - 1];

        expect(lastCallArgs2).toBeDefined();
        const updates2 = lastCallArgs2[1];

        expect(updates2).toHaveLength(1);
        expect(updates2[0].type).toBe('remove');
        expect(updates2[0].routeId).toBe(routeId);
    });
});
