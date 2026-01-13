import { Hono } from 'hono';
import { websocket } from 'hono/bun';
import { createKeyManagerFromEnv } from './key-manager/factory.js';
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js';
import { InMemoryRevocationStore } from './revocation.js';

// Initialize KeyManager using factory pattern
const keyManager = createKeyManagerFromEnv();
await keyManager.initialize();

const currentKid = await keyManager.getCurrentKeyId();
console.log(JSON.stringify({ level: 'info', msg: 'KeyManager initialized', kid: currentKid }));

// Initialize revocation store if enabled
const revocationEnabled = process.env.CATALYST_AUTH_REVOCATION === 'true';
const revocationMaxSize = Number(process.env.CATALYST_AUTH_REVOCATION_MAX_SIZE) || undefined;
const revocationStore = revocationEnabled
    ? new InMemoryRevocationStore({ maxSize: revocationMaxSize })
    : undefined;

if (revocationStore) {
    console.log(JSON.stringify({ level: 'info', msg: 'Token revocation enabled', maxSize: revocationStore.maxSize }));
}

const app = new Hono();

// Initialize the RPC server
const rpcServer = new AuthRpcServer(keyManager, revocationStore);
const rpcApp = createAuthRpcHandler(rpcServer);

// Health check endpoint
app.get('/', (c) => c.text('Catalyst Auth Service'));
app.get('/health', (c) => c.json({ status: 'ok' }));

// JWKS endpoint (standard path for key discovery)
app.get('/.well-known/jwks.json', async (c) => {
    const jwks = await keyManager.getJwks();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(jwks);
});

// Mount the RPC handler
app.route('/rpc', rpcApp);

const port = Number(process.env.PORT) || 4001;
console.log(JSON.stringify({ level: 'info', msg: 'Auth service started', port }));

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...' }));
    await keyManager.shutdown();
    process.exit(0);
});

export default {
    fetch: app.fetch,
    port,
    websocket,
};

// Re-export for library usage
export * from './keys.js';
export { signToken, verifyToken, decodeToken, SignOptionsSchema, VerifyResultSchema } from './jwt.js';
export type { SignOptions, VerifyOptions, VerifyResult } from './jwt.js';
export * from './revocation.js';
export * from './key-manager/index.js';
export * from './rpc/schema.js';
export { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js';
