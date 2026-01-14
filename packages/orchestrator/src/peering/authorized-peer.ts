
import { RpcTarget } from 'capnweb';
import { Action } from '../rpc/schema/index.js';

export interface PeerInfo {
    id: string;
    as: number;
    agentVersion?: string;
    capabilities?: string[];
}

export interface PeerSessionState {
    accepted: boolean;
    peerInfo?: PeerInfo; // Identity of the acceptor
    peers?: any[]; // Simplified for now
    jwks?: any;
}

export class AuthorizedPeerImpl extends RpcTarget {
    private peerId?: string;

    constructor(private dispatch: (action: Action) => Promise<any>) {
        super();
    }

    async open(info: PeerInfo, clientStub: any): Promise<PeerSessionState> {
        console.log(`[AuthorizedPeer] Received OPEN from peer ${info.id} (AS ${info.as})`);
        this.peerId = info.id;

        // Dispatch action to internal-as plugin to handle registration
        // We pass the stub in the data. Note: 'any' type in schema allows this.
        await this.dispatch({
            resource: 'internalPeerSession',
            resourceAction: 'open',
            data: {
                peerInfo: info,
                clientStub,
                direction: 'inbound'
            }
        });

        const localInfo: PeerInfo = {
            id: process.env.CATALYST_NODE_ID || 'unknown-server',
            as: parseInt(process.env.CATALYST_AS || '0')
        };

        return {
            accepted: true,
            peerInfo: localInfo,
            peers: [], // Populate with current peers if accessible
            jwks: {}
        };
    }

    async close(peerId: string): Promise<void> {
        console.log(`[AuthorizedPeer] Closing session for ${peerId}`);
        await this.dispatch({
            resource: 'internalPeerSession',
            resourceAction: 'close',
            data: { peerId }
        });
    }

    async updateRoute(message: any): Promise<void> {
        // Dispatch to plugin
        // Message matches UpdateMessageSchema (roughly)
        await this.dispatch({
            resource: 'internalBGPRoute',
            resourceAction: 'update',
            data: message
        });
    }

    async keepAlive(): Promise<void> {
        // Dispatch to plugin to update lastSeen
        if (this.peerId) {
            await this.dispatch({
                resource: 'internalPeerSession',
                resourceAction: 'keepAlive',
                data: { peerId: this.peerId }
            });
        }
    }
}
