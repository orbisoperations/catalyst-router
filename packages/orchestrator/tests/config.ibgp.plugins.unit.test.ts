import { describe, it, expect } from 'bun:test';
import { InternalBGPPlugin } from '../src/plugins/implementations/Internal-bgp.js';
import { RouteTable } from '../src/state/route-table.js';
import { PluginContext } from '../src/plugins/types.js';
import { IBGPConfigResource, IBGPConfigResourceAction } from '../src/rpc/schema/peering.js';

describe('InternalBGPPlugin Config Unit Tests', () => {

    it('should handle create peer action', async () => {
        const plugin = new InternalBGPPlugin();
        const initialState = new RouteTable();

        const context: PluginContext = {
            action: {
                resource: IBGPConfigResource.value,
                resourceAction: IBGPConfigResourceAction.enum.create,
                data: {
                    endpoint: 'http://peer-a:3000/rpc',
                    secret: 'peer-secret'
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const peers = result.ctx.state.getPeers();
        expect(peers).toHaveLength(1);
        expect(peers[0].endpoint).toBe('http://peer-a:3000/rpc');
    });

    it('should handle update peer action', async () => {
        const plugin = new InternalBGPPlugin();
        const endpoint = 'http://peer-old:3000/rpc';
        const peerId = 'peer-http---peer-old-3000-rpc';

        const stateWithPeer = new RouteTable().addPeer({
            id: peerId,
            as: 0,
            endpoint: endpoint,
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: IBGPConfigResource.value,
                resourceAction: IBGPConfigResourceAction.enum.update,
                data: {
                    peerId: peerId,
                    endpoint: 'http://peer-new:3000/rpc',
                    secret: 'new-secret'
                }
            },
            state: stateWithPeer,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const updatedPeer = result.ctx.state.getPeer(peerId);
        expect(updatedPeer?.endpoint).toBe('http://peer-new:3000/rpc');
    });

    it('should handle delete peer action', async () => {
        const plugin = new InternalBGPPlugin();
        const peerId = 'peer-to-delete';

        const stateWithPeer = new RouteTable().addPeer({
            id: peerId,
            as: 100,
            endpoint: 'http://peer-to-delete:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: IBGPConfigResource.value,
                resourceAction: IBGPConfigResourceAction.enum.delete,
                data: {
                    peerId: peerId
                }
            },
            state: stateWithPeer,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const peers = result.ctx.state.getPeers();
        expect(peers).toHaveLength(0);
    });
});
