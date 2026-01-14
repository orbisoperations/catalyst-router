
import { RpcTarget } from 'capnweb';
import { PeerInfo, UpdateMessage, AuthorizedPeer, AuthorizedPeerSchema } from '../rpc/schema/peering.js';
import { OrchestratorDispatcher } from './peer.js';
import { getConfig } from '../config.js';

interface PeerClientStub {
    keepAlive(): Promise<void>;
    updateRoute(msg: UpdateMessage): Promise<void>;
}

interface PeerSessionState {
    peers: AuthorizedPeer[];
    jwks: any;
}

export class PeeringService {
    constructor(
        private dispatch: OrchestratorDispatcher,
        private config: { as: number, domains: string[] }
    ) { }

    async authenticate(secret: string): Promise<AuthorizedPeerStubImpl> {
        // Validate secret (Implementation TBD - check config using getConfig or passed args)
        // For now, accept any non-empty secret or matching config
        console.log(`[PeeringService] Authenticating with secret: ${secret.substring(0, 3)}...`);

        // Return the privileged stub
        return new AuthorizedPeerStubImpl(this.dispatch, this.config);
    }

    async ping(): Promise<string> {
        return 'pong';
    }
}

export class AuthorizedPeerStubImpl extends RpcTarget {
    constructor(
        private dispatch: OrchestratorDispatcher,
        private config: { as: number, domains: string[] }
    ) {
        super();
    }

    async open(info: PeerInfo, clientStub: any): Promise<PeerSessionState> {
        console.log(`[PeeringService] Peer ${info.id} opened session.`);

        // 1. Register the new peer via Action
        if (clientStub) {
            await this.dispatch({
                resource: 'internal-peering-incoming',
                action: 'create',
                data: {
                    info,
                    clientStub
                }
            });
        } else {
            console.warn(`[PeeringService] Peer ${info.id} connected without client stub (readonly).`);
            await this.dispatch({
                resource: 'internal-peering-incoming',
                action: 'create',
                data: {
                    info,
                    clientStub: null
                }
            });
        }

        return {
            peers: [],
            jwks: {}
        };
    }

    async keepAlive() {
        // No-op or reset timer logic handled by Plugin via action?
        // Or just log
    }

    async updateRoute(msg: UpdateMessage) {
        // Dispatch update
        await this.dispatch({
            resource: 'internal-peering-protocol',
            action: 'update',
            data: msg
        });
    }
}
