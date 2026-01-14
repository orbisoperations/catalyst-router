
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
        expect(dispatchedAction.resource).toBe('open:internal-as');
        expect(dispatchedAction.data.peerInfo.id).toBe('test-node');
    });

    it('InternalAutonomousSystemPlugin should handle open:internal-as', async () => {
        const plugin = new InternalAutonomousSystemPlugin();
        const context: PluginContext = {
            action: {
                resource: 'open:internal-as',
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
        // In future, verify state.peers is updated
    });
});
