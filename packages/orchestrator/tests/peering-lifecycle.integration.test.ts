
import { describe, it, expect } from 'bun:test';
import { OrchestratorRpcServer } from '../src/rpc/server.js';
import { RouteTable } from '../src/state/route-table.js';
import { AuthorizedPeer } from '../src/rpc/schema/peering.js';

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
            resource: 'internalPeerConfig',
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
            resource: 'internalPeerSession',
            resourceAction: 'open',
            data: {
                peerInfo: { id: 'peer-node-1', as: 200, endpoint: 'ws://peer-1', domains: ['d1'] },
                clientStub: {}, // stub
                direction: 'inbound'
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
            resource: 'internalPeerSession',
            resourceAction: 'close',
            data: {
                peerId: 'peer-node-1'
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
            resource: 'internalPeerSession',
            resourceAction: 'open',
            data: {
                peerInfo: { id: peerId, as: 300, endpoint: 'ws://p2', domains: [] },
                clientStub: {},
                direction: 'inbound'
            }
        } as any);

        // 2. Add Route from that Peer via BGP Update action
        // Note: The plugin now supports 'internalBGPRoute/update'
        const serviceName = 'service-from-peer';
        await server.applyAction({
            resource: 'internalBGPRoute',
            resourceAction: 'update',
            data: {
                type: 'add',
                route: {
                    name: serviceName,
                    endpoint: 'http://peer-endpoint',
                    protocol: 'tcp'
                },
                sourcePeerId: peerId
            }
        } as any);

        // 3. Verify Route Exists
        const routesAfterAdd = await server.listLocalRoutes();
        const peerRoute = routesAfterAdd.routes.find(r => r.service.name === serviceName);
        expect(peerRoute).toBeDefined();
        expect(peerRoute?.sourcePeerId).toBe(peerId);

        // 4. Disconnect Peer
        await server.applyAction({
            resource: 'internalPeerSession',
            resourceAction: 'close',
            data: {
                peerId
            }
        } as any);

        // 5. Verify Route Removed
        const routesAfterDisconnect = await server.listLocalRoutes();
        const routeGone = routesAfterDisconnect.routes.find(r => r.service.name === serviceName);
        expect(routeGone).toBeUndefined();
    });
});
