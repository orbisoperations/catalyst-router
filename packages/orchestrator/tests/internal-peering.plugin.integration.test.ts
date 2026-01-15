
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';
import { InternalBGPPlugin } from '../src/plugins/implementations/Internal-bgp.js';

describe('Internal Peering Integration', () => {

    it('InternalBGPPlugin should handle open:internal-as', async () => {
        const plugin = new InternalBGPPlugin();
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

    it('InternalBGPPlugin should handle close:internal-as and cleanup routes', async () => {
        const plugin = new InternalBGPPlugin();
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
