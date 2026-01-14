
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { JwtService } from './service.js';

const app = new Hono();
const service = new JwtService();

app.get('/rpc', (c) => {
    return newRpcResponse(c, service, {
        upgradeWebSocket,
    });
});

app.get('/health', (c) => c.text('OK'));

const port = parseInt(process.env.CATALYST_AUTH_PORT || '4020', 10);
console.log(`Auth Service running on port ${port}`);

export default {
    port,
    fetch: app.fetch,
    websocket,
};
