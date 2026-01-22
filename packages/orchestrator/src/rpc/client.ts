import { newHttpBatchRpcSession, newWebSocketRpcSession } from 'capnweb';
import type { PublicIBGPScope } from './schema/peering.js';

export function getHttpPeerSession(endpoint: string, secret: string) {
    const session = newHttpBatchRpcSession<PublicIBGPScope>(endpoint);
    return session.connectToIBGPPeer(secret);
}

export function getWebSocketPeerSession(endpoint: string, secret: string) {
    const session = newWebSocketRpcSession<PublicIBGPScope>(endpoint);
    return session.connectToIBGPPeer(secret);
}
