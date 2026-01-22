
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { OrchestratorRpcServer } from '../src/rpc/server.js';
import { BGPPeeringServer } from '../src/peering/rpc-server.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';
import { InternalAutonomousSystemPlugin } from '../src/peering/plugins/InternalAutonomousSystem.js';

describe('Internal Peering Integration', () => {

    // We can't easily spin up full WebSockets in this unit/hybrid test environment without Hono running.
    // However, we can mock the "remote" connection part in the plugin 
    // OR we can test the components in isolation (Server logic + Plugin Logic).

    // Strategy: Test the Plugin's ability to dispatch 'authenticate' and 'open' logic 
    // by mocking the 'newWebSocketRpcSession' if possible, OR
    // just test that the 'BGPPeeringServer' works as expected.

    it('BGPPeeringServer should authorize and return AuthorizedPeer', async () => {
        const mockDispatch = async (action: any) => {
            return { success: true };
        };
        const server = new BGPPeeringServer({ actionHandler: mockDispatch });
        const authorized = await server.authorize('secret');

        expect(authorized).toBeDefined();
        expect(authorized.open).toBeDefined();
    });

    it('AuthorizedPeer should dispatch open:internal-as action', async () => {
        let dispatchedAction: any = null;
        const mockDispatch = async (action: any) => {
            dispatchedAction = action;
            return { success: true };
        };
        const server = new BGPPeeringServer({ actionHandler: mockDispatch });
        const authorized = await server.authorize('secret');

        const info = { id: 'test-node', as: 100 };
        const stub = { keepAlive: () => { } };

        const result = await authorized.open(info, stub);

        expect(result.accepted).toBe(true);
        expect(dispatchedAction).toBeDefined();
        expect(dispatchedAction.resource).toBe('internalPeerSession');
        expect(dispatchedAction.resourceAction).toBe('open');
        expect(dispatchedAction.data.peerInfo.id).toBe('test-node');
    });

    it('InternalAutonomousSystemPlugin should handle open:internal-as', async () => {
        const plugin = new InternalAutonomousSystemPlugin();
        const context: PluginContext = {
            action: {
                resource: 'internalPeerSession',
                resourceAction: 'open',
                data: {
                    peerInfo: { id: 'remote-1', as: 200 },
                    clientStub: {},
                    direction: 'inbound'
                }
            },
            state: new RouteTable(),
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        // Verify peer was added
        expect(result.ctx.state.getPeers()).toHaveLength(1);
        expect(result.ctx.state.getPeers()[0].id).toBe('remote-1');
    });

    it('AuthorizedPeer.close() should dispatch internalPeerSession/close action', async () => {
        let dispatchedAction: any = null;
        const mockDispatch = async (action: any) => {
            dispatchedAction = action;
            return { success: true };
        };
        const server = new BGPPeeringServer({ actionHandler: mockDispatch });
        const authorized = await server.authorize('secret');

        await authorized.close('peer-123');

        expect(dispatchedAction).toBeDefined();
        expect(dispatchedAction.resource).toBe('internalPeerSession');
        expect(dispatchedAction.resourceAction).toBe('close');
        expect(dispatchedAction.data.peerId).toBe('peer-123');
    });

    it('InternalAutonomousSystemPlugin should handle close:internal-as and cleanup routes', async () => {
        const plugin = new InternalAutonomousSystemPlugin();
        let state = new RouteTable();

        // Seed state with a peer and a route from that peer
        const peer = { id: 'remote-exit', as: 300, endpoint: 'ws://host', domains: [] };
        state = state.addPeer(peer).state;

        state = state.addInternalRoute({
            name: 'service-from-peer',
            endpoint: 'http://peer-endpoint',
            protocol: 'tcp'
        }, 'remote-exit').state;

        // Ensure seeded correctly
        expect(state.getPeers()).toHaveLength(1);
        expect(state.getInternalRoutes()).toHaveLength(1);
        expect(state.getInternalRoutes()[0].sourcePeerId).toBe('remote-exit');

        const context: PluginContext = {
            action: {
                resource: 'internalPeerSession',
                resourceAction: 'close',
                data: { peerId: 'remote-exit' }
            },
            state,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);

        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');
        expect(result.ctx.state.getPeers()).toHaveLength(0);
        expect(result.ctx.state.getInternalRoutes()).toHaveLength(0);
    });
});
