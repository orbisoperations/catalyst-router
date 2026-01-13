
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { OrchestratorRpcServer } from './rpc/server.js';
export * from './rpc/schema/index.js';

const app = new Hono();
const rpcServer = new OrchestratorRpcServer();

app.get('/rpc', (c) => {
    return newRpcResponse(c, rpcServer, {
        upgradeWebSocket,
    });
});

app.get('/health', (c) => c.text('OK'));

const port = process.env.PORT || 4015;
console.log(`Orchestrator running on port ${port}`);

export default {
    port,
    fetch: app.fetch,
    websocket,
};
