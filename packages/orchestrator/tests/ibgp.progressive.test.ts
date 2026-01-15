
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { newWebSocketRpcSession } from 'capnweb';
import app from '../src/index.js';

describe('Orchestrator iBGP Progressive API', () => {
    let server: any;
    let rpc: any;
    let ws: WebSocket;
    const port = 4018;

    beforeAll(async () => {
        server = Bun.serve({
            port,
            fetch: app.fetch,
            websocket: app.websocket
        });

        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 100));

        ws = new WebSocket(`ws://localhost:${port}/rpc`);
        await new Promise<void>((resolve) => {
            ws.addEventListener('open', () => resolve());
        });

        rpc = newWebSocketRpcSession(ws as any);
    });

    afterAll(() => {
        if (ws) ws.close();
        server.stop();
    });

    it('should successfully obtain IBGP scope with valid secret', async () => {
        const secret = 'some-secret';
        const ibgp = rpc.connectionFromIBGPPeer(secret);
        expect(ibgp).toBeDefined();
    });

    it('should fail to obtain IBGP scope with empty secret', async () => {
        try {
            await rpc.connectionFromIBGPPeer('');
            throw new Error('Should have failed');
        } catch (e: any) {
            expect(e.message).toContain('Invalid secret');
        }
    });

    it('should handle open session call', async () => {
        const secret = 'valid-secret';
        const ibgp = rpc.connectionFromIBGPPeer(secret);

        // Mock callback stub (client-side)
        const callback = {
            update: async (routes: any) => {
                console.log('Received update:', routes);
            }
        };

        const peerInfo = await ibgp.open(callback);
        expect(peerInfo).toBeDefined();
        expect(peerInfo.id).toBe('local-node');
        expect(peerInfo.as).toBe(100);
    });

    it('should accept route updates', async () => {
        const secret = 'valid-secret';
        const ibgp = rpc.connectionFromIBGPPeer(secret);

        const dummyRoutes = [{ id: 'route-1' }];
        const result = await ibgp.update(dummyRoutes);

        expect(result.success).toBe(true);
    });
});
