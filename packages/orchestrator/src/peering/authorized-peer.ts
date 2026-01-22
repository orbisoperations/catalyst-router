
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
    peers?: any[]; // Simplified for now
    jwks?: any;
}

export class AuthorizedPeerImpl extends RpcTarget {
    constructor(private dispatch: (action: Action) => Promise<any>) {
        super();
    }

    async open(info: PeerInfo, clientStub: any): Promise<PeerSessionState> {
        console.log(`[AuthorizedPeer] Received OPEN from peer ${info.id} (AS ${info.as})`);

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

        // For now, return a successful session state stub
        // In a real implementation, the plugin result would dictate this return value,
        // but 'dispatch' usually returns Generic Result. We might need to query state or trust dispatch.
        // Assuming dispatch success means accepted.

        return {
            accepted: true,
            peers: [], // Populate with current peers if accessible
            jwks: {}
        };
    }
}
