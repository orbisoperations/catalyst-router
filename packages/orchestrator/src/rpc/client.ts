import { newHttpBatchRpcSession, newWebSocketRpcSession } from 'capnweb';
import type { PublicIBGPScope } from './schema/peering.js';

export function getHttpPeerSession(endpoint: string, secret: string) {
    const wsEndpoint = endpoint.replace(/^http/, 'ws');
    const session = newWebSocketRpcSession<PublicIBGPScope>(wsEndpoint);
    return session.connectToIBGPPeer(secret);
}

export function getWebSocketPeerSession(endpoint: string, secret: string) {
    const session = newWebSocketRpcSession<PublicIBGPScope>(endpoint);
    return session.connectToIBGPPeer(secret);
}
