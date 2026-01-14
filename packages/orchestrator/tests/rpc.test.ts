
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { newWebSocketRpcSession } from 'capnweb';
import app from '../src/index.js';

describe('Orchestrator RPC', () => {
    let server: any;
    let rpc: any;
    let ws: WebSocket;
    const port = 4017;

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

    it('should apply create data channel action', async () => {
        const action = {
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'test-service',
                endpoint: 'http://127.0.0.1:8080',
                protocol: 'http:graphql',
                region: 'us-west-1'
            }
        };

        const result = await rpc.applyAction(action);
        expect(result.success).toBe(true);
        expect(result.results[0].id).toBe('test-service:tcp:graphql');
    });

    it('should list local routes', async () => {
        const action = {
            resource: 'local-routing',
            action: 'create-datachannel',
            data: {
                name: 'test-service',
                endpoint: 'http://127.0.0.1:8080',
                protocol: 'http:graphql',
                region: 'us-west-1'
            }
        };

        const applyActionResult = await rpc.applyAction(action);
        expect(applyActionResult.success).toBe(true);
        expect(applyActionResult.id).toBe('test-service:http:graphql');
        const listLocalRoutesResult = await rpc.listLocalRoutes();
        expect(listLocalRoutesResult.routes).toBeInstanceOf(Array);
        expect(listLocalRoutesResult.routes.length).toBeGreaterThan(0);
        const route = listLocalRoutesResult.routes.find((r: any) => r.id === 'test-service:http:graphql');
        expect(route).toBeDefined();
        expect(route.service.name).toBe('test-service');
    });

    it('should list metrics', async () => {
        const action = {
            resource: 'local-routing',
            action: 'create-datachannel',
            data: {
                name: 'test-service',
                endpoint: 'http://127.0.0.1:8080',
                protocol: 'http:graphql',
                region: 'us-west-1'
            }
        };

        const applyActionResult = await rpc.applyAction(action);
        expect(applyActionResult.success).toBe(true);
        expect(applyActionResult.id).toBe('test-service:http:graphql');
        const listMetricsResult = await rpc.listMetrics();
        expect(listMetricsResult.metrics).toBeInstanceOf(Array);
        const metric = listMetricsResult.metrics.find((m: any) => m.id === 'test-service:http:graphql');
        expect(metric).toBeDefined();
        expect(metric.connectionCount).toBe(0);
    });
});
