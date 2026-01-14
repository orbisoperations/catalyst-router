import type {
    Action,
    AddDataChannelResult,
    ListLocalRoutesResult,
    ListMetricsResult
} from '@catalyst/orchestrator';
import { newWebSocketRpcSession } from 'capnweb';
import { WebSocket } from 'ws';

// Polyfill Symbol.asyncDispose if necessary (TypeScript < 5.2 or older environments)
// @ts-ignore
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose');

export interface OrchestratorRpc {
    applyAction(action: Action): Promise<AddDataChannelResult>;
    listLocalRoutes(): Promise<ListLocalRoutesResult>;
    listMetrics(): Promise<ListMetricsResult>;
}

export type DisposableOrchestratorRpc = OrchestratorRpc & AsyncDisposable;

export async function createClient(url: string = 'ws://localhost:3000/rpc'): Promise<DisposableOrchestratorRpc> {
    // In Node, we need to provide a WebSocket implementation usually.
    // However, capnweb 0.4.x might expect a browser-like WebSocket.
    // Let's assume global WebSocket or pass it if the API supports it.

    // Quick hack for global WebSocket in Node if not present
    if (!globalThis.WebSocket) {
        // @ts-ignore
        globalThis.WebSocket = WebSocket;
    }

    const connectionUrl = process.env.CATALYST_ORCHESTRATOR_URL || url;

    // Manually create WebSocket so we can close it
    const ws = new WebSocket(connectionUrl);

    // Wait for open? capnweb usually handles this, but sticking to existing pattern for now.
    // Actually capnweb `newWebSocketRpcSession` takes a URL or a WebSocket factory/instance?
    // Looking at previous code: `newWebSocketRpcSession(connectionUrl, { WebSocket: WebSocket as any })`
    // It seems it takes the Class.
    // Let's see if we can pass the instance. The types might not allow it easily without checking docs.
    // If we pass the URL, capnweb creates the socket. We can't easily get it back to close it.
    // EXCEPT, if we provide a custom factory that captures it.

    let capturedWs: any = null;
    const WebSocketProxy = new Proxy(WebSocket, {
        construct(target, args) {
            const instance = new (target as any)(...args);
            capturedWs = instance;
            return instance;
        }
    });

    const clientStub = newWebSocketRpcSession<OrchestratorRpc>(connectionUrl, {
        WebSocket: WebSocketProxy as any
    });

    // Return a proxy that implements AsyncDisposable
    const proxy = new Proxy(clientStub, {
        get(target, prop, receiver) {
            if (prop === Symbol.asyncDispose) {
                return async () => {
                    if (capturedWs) {
                        capturedWs.close();
                    }
                };
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    return proxy as unknown as DisposableOrchestratorRpc;
}

export type RpcClient = DisposableOrchestratorRpc;
