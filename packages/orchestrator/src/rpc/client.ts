import { newHttpBatchRpcSession } from 'capnweb';
import type { PublicIBGPScope } from './schema/peering.js';

export function getPeerSession(endpoint: string, secret: string) {
    const session = newHttpBatchRpcSession<PublicIBGPScope>(endpoint);
    return session.connectToIBGPPeer(secret);
}
