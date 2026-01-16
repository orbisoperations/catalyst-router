import { describe, it, expect, mock } from 'bun:test';
import { OrchestratorRpcServer } from '../src/rpc/server.js';
import { IBGPConfigResource, IBGPConfigResourceAction } from '../src/rpc/schema/peering.js';

mock.module('../src/rpc/client.js', () => ({
    getPeerSession: () => ({
        open: async () => ({ success: true }),
        update: async () => ({ success: true }),
        close: async () => ({ success: true })
    })
}));

describe('iBGP Config Integration Tests', () => {

    it('should create a peer via applyAction', async () => {
        const server = new OrchestratorRpcServer();
        const endpoint = 'http://peer-a:3000/rpc';

        const action = {
            resource: IBGPConfigResource.value,
            resourceAction: IBGPConfigResourceAction.enum.create,
            data: {
                endpoint
            }
        };

        const result = await server.applyAction(action as any);
        expect(result.success).toBe(true);

        const peersResult = await server.listPeers();
        expect(peersResult.peers).toHaveLength(1);
        expect(peersResult.peers[0].endpoint).toBe(endpoint);
    });

    it('should update a peer via applyAction', async () => {
        const server = new OrchestratorRpcServer();
        const initialEndpoint = 'http://peer-old:3000/rpc';
        const newEndpoint = 'http://peer-new:3000/rpc';

        // 1. Create peer
        await server.applyAction({
            resource: IBGPConfigResource.value,
            resourceAction: IBGPConfigResourceAction.enum.create,
            data: {
                endpoint: initialEndpoint
            }
        } as any);

        const peersResult = await server.listPeers();
        const peerId = peersResult.peers[0].id;

        // 2. Update peer
        const updateAction = {
            resource: IBGPConfigResource.value,
            resourceAction: IBGPConfigResourceAction.enum.update,
            data: {
                peerId,
                endpoint: newEndpoint
            }
        };

        const updateResult = await server.applyAction(updateAction as any);
        expect(updateResult.success).toBe(true);

        const updatedPeersResult = await server.listPeers();
        expect(updatedPeersResult.peers[0].endpoint).toBe(newEndpoint);
    });

    it('should delete a peer via applyAction', async () => {
        const server = new OrchestratorRpcServer();
        const endpoint = 'http://peer-to-delete:3000/rpc';

        // 1. Create peer
        await server.applyAction({
            resource: IBGPConfigResource.value,
            resourceAction: IBGPConfigResourceAction.enum.create,
            data: {
                endpoint
            }
        } as any);

        const peersResult = await server.listPeers();
        const peerId = peersResult.peers[0].id;

        // 2. Delete peer
        const deleteAction = {
            resource: IBGPConfigResource.value,
            resourceAction: IBGPConfigResourceAction.enum.delete,
            data: {
                peerId
            }
        };

        const deleteResult = await server.applyAction(deleteAction as any);
        expect(deleteResult.success).toBe(true);

        const finalPeersResult = await server.listPeers();
        expect(finalPeersResult.peers).toHaveLength(0);
    });
});
