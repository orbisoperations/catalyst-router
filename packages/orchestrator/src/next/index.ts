import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { CatalystNodeBus } from './orchestrator.js';

const app = new Hono();

const nodeId = process.env.CATALYST_NODE_ID || 'myself';
const peeringEndpoint = process.env.CATALYST_PEERING_ENDPOINT || 'http://localhost:3000/rpc';

const bus = new CatalystNodeBus({
    config: {
        node: {
            name: nodeId,
            endpoint: peeringEndpoint,
            domains: []
        }
    },
    connectionPool: { type: 'ws' }
});

app.all('/rpc', (c) => {
    return newRpcResponse(c, bus.publicApi(), {
        upgradeWebSocket,
    });
});

app.get('/health', (c) => c.text('OK'));

const port = Number(process.env.PORT) || 3000;

console.log(`Orchestrator (Next) running on port ${port} as ${nodeId}`);
console.log('NEXT_ORCHESTRATOR_STARTED');

export default {
    port,
    hostname: '0.0.0.0',
    fetch: app.fetch,
    websocket,
};
