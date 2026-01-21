import type { RpcPromise, RpcStub } from 'capnweb';
import { newWebSocketRpcSession } from 'capnweb';

// Polyfill Symbol.asyncDispose if necessary (TypeScript < 5.2 or older environments)
// @ts-expect-error - polyfilling Symbol.asyncDispose
Symbol.asyncDispose ??= Symbol('Symbol.asyncDispose');

export async function createClient(url: string = process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:4015/rpc'): Promise<PublicApi> {
    const clientStub = newWebSocketRpcSession<PublicApi>(url);

    return clientStub as unknown as PublicApi;
}

export type RpcClient = RpcPromise<PublicApi>;

export interface PublicApi {
    connectionFromManagementSDK(): RpcStub<ManagementScope>;
}

export interface ManagementScope {
    applyAction(action: unknown): Promise<unknown>;
    listLocalRoutes(): Promise<unknown>;
    listMetrics(): Promise<unknown>;
    listPeers(): Promise<unknown>;
    deletePeer(peerId: string): Promise<unknown>;
}
