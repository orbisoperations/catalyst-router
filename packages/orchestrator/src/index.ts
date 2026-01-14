
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { newRpcResponse } from '@hono/capnweb';
import { OrchestratorRpcServer } from './rpc/server.js';
<<<<<<< HEAD
export * from './rpc/schema/index.js';
=======
import { BGPPeeringServer } from './peering/rpc-server.js';
>>>>>>> c505d11 (feat: spliting peering from main event loop code)

const app = new Hono();
const rpcServer = new OrchestratorRpcServer();

app.get('/rpc', (c) => {
    return newRpcResponse(c, rpcServer, {
        upgradeWebSocket,
    });
});

const bgpServer = new BGPPeeringServer({
    actionHandler: (action) => rpcServer.applyAction(action)
});
app.get('/ibgp', (c) => {
    return newRpcResponse(c, bgpServer, {
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
