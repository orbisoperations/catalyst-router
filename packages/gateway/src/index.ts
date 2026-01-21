import { Hono } from 'hono';
import { websocket } from 'hono/bun';
import { createGatewayHandler } from './graphql/server.js';
import { GatewayRpcServer, createRpcHandler } from './rpc/server.js';


const app = new Hono();



const { app: graphqlApp, server: gateway } = createGatewayHandler();

// Initialize the RPC server logic
const rpcServer = new GatewayRpcServer(async (config) => {
    return gateway.reload(config);
});
const rpcApp = createRpcHandler(rpcServer);

// Root endpoint
app.get('/', (c) => c.text('Catalyst GraphQL Gateway is running.'));

// Mount the sub-apps
app.route('/graphql', graphqlApp);
app.route('/api', rpcApp);

const port = Number(process.env.PORT) || 4000;
console.log(`Starting server on port ${port}...`);

export default {
    fetch: app.fetch,
    port,
    websocket,
};
