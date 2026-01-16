import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { OrchestratorRpcServer } from './rpc/server.js';

// Schemas and Types Exports
export * from './rpc/schema/index.js';
export * from './rpc/schema/peering.js';
export * from './rpc/schema/actions.js';
export * from './rpc/schema/direct.js';

const app = new Hono();
const rpcServer = new OrchestratorRpcServer();

app.all('/rpc', (c) => {
    return newRpcResponse(c, rpcServer, {
        upgradeWebSocket,
    });
});

app.get('/health', (c) => c.text('OK'));

const port = Number(process.env.PORT) || 4015;

if (import.meta.main) {
    console.log(`Orchestrator running on port ${port}`);
}

export default {
    port,
    hostname: '0.0.0.0',
    fetch: app.fetch,
    websocket,
};
