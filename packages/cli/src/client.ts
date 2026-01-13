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

export class CliClient implements OrchestratorRpc, AsyncDisposable {
    private ws: WebSocket | null = null;
    private rpc: OrchestratorRpc;

    constructor(url: string = 'ws://localhost:3000/rpc') {
        const connectionUrl = process.env.CATALYST_ORCHESTRATOR_URL || url;

        // Quick hack for global WebSocket in Node if not present
        if (!globalThis.WebSocket) {
            // @ts-ignore
            globalThis.WebSocket = WebSocket;
        }

        let capturedWs: any = null;
        // Proxy WebSocket constructor to capture the instance so we can close it later
        const WebSocketProxy = new Proxy(WebSocket, {
            construct(target, args) {
                const instance = new (target as any)(...args);
                capturedWs = instance;
                return instance;
            }
        });

        this.rpc = newWebSocketRpcSession<OrchestratorRpc>(connectionUrl, {
            WebSocket: WebSocketProxy as any
        });
        this.ws = capturedWs;
    }

    async applyAction(action: Action): Promise<AddDataChannelResult> {
        return this.rpc.applyAction(action);
    }

    async listLocalRoutes(): Promise<ListLocalRoutesResult> {
        return this.rpc.listLocalRoutes();
    }

    async listMetrics(): Promise<ListMetricsResult> {
        return this.rpc.listMetrics();
    }

    async [Symbol.asyncDispose]() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

export async function createClient(url?: string): Promise<CliClient> {
    return new CliClient(url);
}

export type RpcClient = CliClient;
