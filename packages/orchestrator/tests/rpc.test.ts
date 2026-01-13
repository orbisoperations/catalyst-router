
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { newWebSocketRpcSession } from 'capnweb';

describe('Orchestrator RPC', () => {
    let server: any;
    let rpc: any;
    let ws: WebSocket;
    const port = 4017;
    let app: any;

    beforeAll(async () => {
        process.env.CATALYST_DOMAINS = 'internal';

        // Dynamic import to ensure ENV is set before config loads
        const module = await import('../src/index.js');
        app = module.default;

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
            resource: 'dataChannel',
            action: 'create',
            data: {
                name: 'test-service',
                fqdn: 'test.internal',
                endpoint: 'http://127.0.0.1:8080',
                protocol: 'tcp:graphql',
                region: 'us-west-1'
            }
        };

        const result = await rpc.applyAction(action);
        expect(result.success).toBe(true);
        expect(result.id).toBe('test.internal');
    });

    it('should list local routes', async () => {
        const result = await rpc.listLocalRoutes();
        expect(result.routes).toBeInstanceOf(Array);
        expect(result.routes.length).toBeGreaterThan(0);
        const route = result.routes.find((r: any) => r.id === 'test.internal');
        expect(route).toBeDefined();
        expect(route.service.name).toBe('test-service');
    });

    it('should list metrics', async () => {
        const result = await rpc.listMetrics();
        expect(result.metrics).toBeInstanceOf(Array);
        const metric = result.metrics.find((m: any) => m.id === 'test.internal');
        expect(metric).toBeDefined();
        expect(metric.connectionCount).toBe(0);
    });
});
