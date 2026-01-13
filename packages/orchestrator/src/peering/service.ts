import {
    PeerPublicApi,
    AuthorizedPeer,
    PeerClient,
    PeerInfo,
    UpdateMessage,
    PeerSessionState
} from '../rpc/schema/peering.js';

// The Privileged Stub returned after authentication
import { GlobalRouteTable } from '../state/route-table.js';
import { Peer } from './peer.js';
import { getConfig } from '../config.js';

import { RpcTarget } from 'capnweb';

// The Privileged Stub returned after authentication
class AuthorizedPeerStub extends RpcTarget implements AuthorizedPeer {
    private client: PeerClient | null = null;
    private peerId: string | null = null;

    constructor(
        private secret: string,
        private getState: () => any, // RouteTable (circular dependency issues might arise if explicit type used)
        private setState: (s: any) => void
    ) {
        super();
        console.log('[AuthorizedPeerStub] Created');
    }

    async open(info: PeerInfo, clientStub: PeerClient): Promise<PeerSessionState> {
        console.log(`[PeeringService] Open request from ${info.id} (${info.endpoint}) AS:${info.as}`);

        const config = getConfig();
        const localAs = config.peering.as;

        if (info.as !== localAs) {
            console.warn(`[PeeringService] Rejected peer ${info.id}: AS mismatch (Remote: ${info.as}, Local: ${localAs})`);
            return {
                accepted: false,
                peers: [],
                domains: [],
                authEndpoint: undefined
            };
        }

        this.client = clientStub;
        this.peerId = info.id;

        // Register Peer
        const localInfo: PeerInfo = {
            id: 'local-node', // TODO: Identifier from config/keys
            as: localAs,
            endpoint: 'tcp://localhost:4015', // TODO: Discovery endpoint
            domains: config.peering.domains,
        };

        // We initialize Peer with the remote info
        const peer = new Peer(info.endpoint, localInfo, () => {
            const s = this.getState();
            const newS = s.removePeer(info.id);
            this.setState(newS);
        });
        // Set remote info including domains
        peer.setRemoteInfo(info);

        await peer.accept(info, clientStub);

        // Update State
        const currentState = this.getState();
        const { state: newState } = currentState.addPeer(peer);
        this.setState(newState);

        return {
            accepted: true,
            peers: [], // pending implementation of peer store
            domains: config.peering.domains,
            jwks: {},
            authEndpoint: 'http://auth.internal'
        };
    }

    async keepAlive(): Promise<void> {
    }

    async updateRoute(msg: UpdateMessage): Promise<void> {
        console.log('[PeeringService] Received Route Update:', msg);
    }

    async close(): Promise<void> {
        console.log(`[PeeringService] Peer ${this.peerId} requested close`);
        if (this.peerId) {
            const currentState = this.getState();
            const newState = currentState.removePeer(this.peerId);
            this.setState(newState);
        }
    }
}

// The Public Service exposed on /rpc
export class PeeringService implements PeerPublicApi {
    constructor(
        private getState: () => any, // RouteTable
        private setState: (s: any) => void
    ) { }

    authenticate(secret: string): AuthorizedPeer {
        console.log(`[PeeringService] Authenticating with secret: ${secret}`);
        if (secret !== 'valid-secret') {
            console.warn('[PeeringService] Invalid secret used');
        }

        return new AuthorizedPeerStub(secret, this.getState, this.setState);
    }

    async ping(): Promise<string> {
        console.log('[PeeringService] Ping received');
        return 'pong';
    }
}
