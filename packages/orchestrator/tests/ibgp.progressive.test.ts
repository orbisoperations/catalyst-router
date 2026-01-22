import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { newHttpBatchRpcSession } from 'capnweb';
import app from '../src/index.js';

describe('Orchestrator iBGP Progressive API', () => {
    let server: any;
    const port = 4018;

    beforeAll(async () => {
        server = Bun.serve({
            port,
            fetch: app.fetch,
            websocket: app.websocket
        });

        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    afterAll(() => {
        server.stop();
    });

    const getRpc = () => newHttpBatchRpcSession(`http://localhost:${port}/rpc`);

    it('should successfully obtain IBGP scope with valid shared secret', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret'; // Matches default in config.ts
        const ibgp = rpc.connectionFromIBGPPeer(secret);
        expect(ibgp).toBeDefined();
    });

    it('should fail to obtain IBGP scope with incorrect secret', async () => {
        const rpc = getRpc();
        try {
            await rpc.connectionFromIBGPPeer('wrong-secret');
            throw new Error('Should have failed');
        } catch (e: any) {
            expect(e.message).toContain('Invalid secret');
        }
    });

    it('should handle open session call and be idempotent', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret';
        const ibgp = rpc.connectionFromIBGPPeer(secret);

        const myPeerInfo = {
            id: 'test-peer',
            as: 200,
            domains: ['test.com'],
            services: [],
            endpoint: 'http://localhost:9999/rpc' // Dummy endpoint
        };

        // First call
        await ibgp.open(myPeerInfo);

        // Second call (should be idempotent)
        // Refresh session for second batch if needed, or pipeline if possible
        const rpc2 = getRpc();
        const ibgp2 = rpc2.connectionFromIBGPPeer(secret);
        await ibgp2.open(myPeerInfo);
    });

    it('should accept route updates', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret';
        const ibgp = rpc.connectionFromIBGPPeer(secret);

        const routeUpdate = {
            type: 'add',
            route: {
                id: 'route-1',
                service: {
                    name: 'test-service',
                    endpoint: 'http://localhost:8080/graphql',
                    protocol: 'tcp:graphql'
                }
            }
        };
        const result = await ibgp.update(routeUpdate);

        expect(result.success).toBe(true);
    });
});
