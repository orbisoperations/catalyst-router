import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { newHttpBatchRpcSession } from 'capnweb';
import { PublicIBGPScope, PeerInfo } from '../src/rpc/schema/peering.js';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { OrchestratorRpcServer } from '../src/rpc/server.js';
import { OrchestratorConfig } from '../src/config.js';

describe('Orchestrator iBGP Progressive API', () => {
    let server: any;
    const port = 4018;

    beforeAll(async () => {
        // Create config manually
        const config: OrchestratorConfig = {
            port,
            as: 65000,
            ibgp: {
                domains: ['test.com'],
                localId: 'test-node',
                endpoint: `http://localhost:${port}/rpc`,
                secret: 'valid-secret'
            }
        };

        const app = new Hono();
        // Inject config!
        const rpcServer = new OrchestratorRpcServer(config);

        app.all('/rpc', (c) => {
            return newRpcResponse(c, rpcServer, {
                upgradeWebSocket,
            });
        });

        server = Bun.serve({
            port,
            fetch: app.fetch,
            websocket: undefined
        });
    });

    afterAll(() => {
        if (server) server.stop();
    });

    const getRpc = () => newHttpBatchRpcSession<PublicIBGPScope>(`http://localhost:${port}/rpc`);

    it('should successfully obtain IBGP scope with valid shared secret', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret';
        const ibgp = rpc.connectToIBGPPeer(secret);
        expect(ibgp).toBeDefined();
    });

    it('should fail to obtain IBGP scope with incorrect secret', async () => {
        const rpc = getRpc();
        try {
            await rpc.connectToIBGPPeer('wrong-secret');
            throw new Error('Should have failed');
        } catch (e: any) {
            expect(e.message).toContain('Invalid secret');
        }
    });

    it('should handle open session call and be idempotent', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret';
        const ibgp = rpc.connectToIBGPPeer(secret);

        const myPeerInfo = {
            id: 'test-peer',
            as: 200,
            domains: ['test.com'],
            endpoint: 'http://localhost:9999/rpc'
        };

        // First call
        await ibgp.open(myPeerInfo);

        // Second call (should be idempotent)
        const rpc2 = getRpc();
        const ibgp2 = rpc2.connectToIBGPPeer(secret);
        await ibgp2.open(myPeerInfo);
    });

    it('should accept route updates', async () => {
        const rpc = getRpc();
        const secret = 'valid-secret';
        const ibgp = rpc.connectToIBGPPeer(secret);

        const myPeerInfo: PeerInfo = {
            id: 'test-peer-updater',
            as: 200,
            domains: ['test.com'],
            endpoint: 'http://localhost:9999/rpc'
        };

        const routeUpdate = {
            type: 'add' as const,
            route: {
                name: 'test-service',
                endpoint: 'http://localhost:8080/graphql',
                protocol: 'http:graphql' as const,
                region: 'us-east-1'
            }
        };
        const result = await ibgp.update(myPeerInfo, [routeUpdate]);

        expect(result.success).toBe(true);
    });
});
