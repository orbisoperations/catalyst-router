import { newHttpBatchRpcSession } from 'capnweb';
import type { PeerApi } from './schema/peering.js';

export function getPeerSession(endpoint: string, secret: string) {
    const session = newHttpBatchRpcSession<PeerApi>(endpoint);
    return session.connectToIBGPPeer(secret);
}
