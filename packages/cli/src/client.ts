import { WebSocket } from 'ws';
import { newWebSocketRpcSession } from 'capnweb';

// Polyfill WebSocket for CapnWeb in Node environment if needed, 
// though capnweb might handle it if passed explicitly or global.
// For node we often need 'ws' package.
// We'll define a simple wrapper.

export async function createClient(url: string = 'ws://localhost:3000/rpc') {
    // In Node, we need to provide a WebSocket implementation usually.
    // However, capnweb 0.4.x might expect a browser-like WebSocket.
    // Let's assume global WebSocket or pass it if the API supports it.

    // Quick hack for global WebSocket in Node if not present
    if (!globalThis.WebSocket) {
        // @ts-ignore
        globalThis.WebSocket = WebSocket;
    }

    const connectionUrl = process.env.CATALYST_ORCHESTRATOR_URL || url;

    // newWebSocketRpcSession in 0.4.x returns the client proxy directly
    const clientStub = newWebSocketRpcSession(connectionUrl, {
        WebSocket: WebSocket as any
    });

    return clientStub;
}

export type RpcClient = Awaited<ReturnType<typeof createClient>>;
