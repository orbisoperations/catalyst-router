import {
    PeerPublicApi,
    AuthorizedPeer,
    PeerClient,
    PeerInfo,
    UpdateMessage,
    PeerSessionState
} from '../rpc/schema/peering.js';
import { Action } from '../rpc/schema/actions.js';
import { RpcTarget } from 'capnweb';
import { Peer } from './peer.js'; // Ensure we import Peer if needed for types or logic

export interface PeeringConfig {
    as: number;
    domains: string[];
    localId: string;
    endpoint: string;
}

// The Privileged Stub returned after authentication
class AuthorizedPeerStub extends RpcTarget implements AuthorizedPeer {
    private client: PeerClient | null = null;
    private peerId: string | null = null;

    constructor(
        private secret: string,
        private config: PeeringConfig,
        private dispatchAction: (action: Action) => Promise<any>
    ) {
        super();
    }

    async open(info: PeerInfo, clientStub: PeerClient): Promise<PeerSessionState> {
        console.log(`[PeeringService] Open request from ${info.id} (${info.endpoint}) AS:${info.as}`);

        const localAs = this.config.as;

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

        // Dispatch 'internal-peering-protocol:open' to pipeline
        // This will eventually update the RouteTable via InternalPeeringPlugin
        await this.dispatchAction({
            resource: 'internal-peering-protocol',
            action: 'open',
            data: {
                peerId: info.id,
                info: info,
                jwks: {},
                clientStub: clientStub
            }
        });

        // We assume the plugin handles validation and state updates. 
        // We return success here if action succeeded.
        // TODO: Action result might be needed here? 
        // For now, assuming dispatch success means accepted.

        return {
            accepted: true,
            peers: [],
            domains: this.config.domains,
            jwks: {},
            authEndpoint: 'http://auth.internal'
        };
    }

    async keepAlive(): Promise<void> {
        if (this.peerId) {
            await this.dispatchAction({
                resource: 'internal-peering-protocol',
                action: 'keepalive',
                data: { peerId: this.peerId }
            });
        }
    }

    async updateRoute(msg: UpdateMessage): Promise<void> {
        if (this.peerId) {
            await this.dispatchAction({
                resource: 'internal-peering-protocol',
                action: 'update',
                data: {
                    peerId: this.peerId,
                    update: msg
                }
            });
        }
    }

    async close(): Promise<void> {
        if (this.peerId) {
            await this.dispatchAction({
                resource: 'internal-peering-protocol',
                action: 'notification',
                data: {
                    peerId: this.peerId,
                    code: 'CEASE',
                    message: 'Peer closed connection'
                }
            });
        }
    }
}

// The Public Service exposed on /rpc
export class PeeringService implements PeerPublicApi {
    private config: PeeringConfig;

    constructor(
        private dispatchAction: (action: Action) => Promise<any>,
        config?: Partial<PeeringConfig>
    ) {
        this.config = {
            as: 65000,
            domains: [],
            localId: 'unknown',
            endpoint: 'http://localhost',
            ...config
        };
    }

    authenticate(secret: string): AuthorizedPeer {
        console.log(`[PeeringService] Authenticating with secret: ${secret} AS:${this.config.as}`);
        return new AuthorizedPeerStub(secret, this.config, this.dispatchAction);
    }

    async ping(): Promise<string> {
        return 'pong';
    }
}
