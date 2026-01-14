
import { RpcTarget } from 'capnweb';
import { AuthorizedPeerImpl } from './authorized-peer.js';
import { Action } from '../rpc/schema/index.js';

export class BGPPeeringServer extends RpcTarget {
    private dispatch: (action: Action) => Promise<any>;

    constructor(options: { actionHandler: (action: Action) => Promise<any> }) {
        super();
        this.dispatch = options.actionHandler;
    }

    async authorize(secret: string): Promise<AuthorizedPeerImpl> {
        // TODO: Validate secret against config/store
        // For now, accept any secret or a simple hardcoded one for dev
        console.log(`[BGPPeeringServer] Authorizing peer with secret length: ${secret.length}`);

        // Return the authorized stub
        return new AuthorizedPeerImpl(this.dispatch);
    }
}
