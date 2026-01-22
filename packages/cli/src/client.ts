import type {
    Action,
    AddDataChannelResult,
    ListLocalRoutesResult,
    ListMetricsResult
} from '@catalyst/orchestrator';
import { newWebSocketRpcSession, RpcPromise } from 'capnweb';
import { WebSocket } from 'ws';

// Polyfill Symbol.asyncDispose if necessary (TypeScript < 5.2 or older environments)
// @ts-ignore
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose');

export async function createClient(url: string = process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:4015/rpc'): Promise<PublicApi> {
    const clientStub = newWebSocketRpcSession<PublicApi>(url);

    return clientStub as unknown as PublicApi;
}

export type RpcClient = RpcPromise<PublicApi>;

export interface PublicApi {
    connectionFromManagementSDK(): Promise<ManagementScope>;
}

export interface ManagementScope {
    applyAction(action: any): Promise<any>;
    listLocalRoutes(): Promise<any>;
    listMetrics(): Promise<any>;
    listPeers(): Promise<any>;
    deletePeer(peerId: string): Promise<any>;
}
