
import { WebSocket } from 'ws';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
import { PeerInfo, UpdateMessage, AuthorizedPeer, AuthorizedPeerSchema } from '../rpc/schema/peering.js';
import { InternalPeeringProtocolUpdateActionSchema } from '../rpc/schema/actions.js';
import { PluginPipeline } from '../plugins/pipeline.js';
import { PipelineAction, PluginResult } from '../plugins/types.js';

interface PeerPublicApi {
    authenticate(secret: string): Promise<AuthorizedPeerStub>;
}

interface AuthorizedPeerStub {
    open(info: PeerInfo, clientStub: any): Promise<PeerSessionState>;
    keepAlive(): Promise<void>;
    updateRoute(msg: UpdateMessage): Promise<void>;
}

interface PeerClientStub {
    keepAlive(): Promise<void>;
    updateRoute(msg: UpdateMessage): Promise<void>;
}

interface PeerSessionState {
    peers: AuthorizedPeer[];
    jwks: any;
}

export type OrchestratorDispatcher = (action: PipelineAction) => Promise<PluginResult>;

// Helper class extending RpcTarget for client implementation
/*
class PeerClientStubImpl extends RpcTarget implements PeerClientStub {
    constructor(private context: Peer) {
        super();
    }

    async keepAlive() {
         // Optionally delegate to context if needed
    }

    async updateRoute(msg: UpdateMessage) {
        // Redirect to Peer
        await (this.context as any).onUpdateRoute(msg);
    }
}
*/

export class Peer {
    public id: string;
    public isConnected: boolean = false;
    public remoteInfo?: PeerInfo;

    // private remoteStub?: AuthorizedPeerStub;
    // private keepAliveTimer?: Timer;

    constructor(
        public endpoint: string,
        private localInfo: PeerInfo,
        private dispatch: OrchestratorDispatcher
    ) {
        this.id = endpoint;
    }

    /*
    async connect(secret: string) {
        if (!globalThis.WebSocket) {
            // @ts-ignore
            globalThis.WebSocket = WebSocket;
        }

        console.log(`[Peer ${this.endpoint}] Connecting...`);
        const publicApi = await newWebSocketRpcSession<PeerPublicApi>(this.endpoint, {
            WebSocket: WebSocket as any
        });

        this.remoteStub = await publicApi.authenticate(secret);

        // Prepare client stub wrapped in RpcTarget
        const clientStub = new PeerClientStubImpl(this);

        console.log(`[Peer ${this.endpoint}] Opening session with info:`, JSON.stringify(this.localInfo));

        // Pass the RpcTarget instance
        const sessionState = await this.remoteStub.open(this.localInfo, clientStub);

        this.remoteInfo = { 
            ...this.localInfo, 
            id: this.endpoint 
        };
        
        this.isConnected = true;
        this.startKeepAlive();
        
        console.log(`[Peer ${this.endpoint}] Connected!`);
        return sessionState;
    }

    async sendUpdate(msg: UpdateMessage) {
        if (!this.isConnected || !this.remoteStub) return;
        try {
            await this.remoteStub.updateRoute(msg);
        } catch (e) {
            console.error(`[Peer ${this.id}] Failed to send update`, e);
            this.disconnect();
        }
    }

    private startKeepAlive() {
        this.keepAliveTimer = setInterval(async () => {
            if (this.isConnected && this.remoteStub) {
                try {
                    await this.remoteStub.keepAlive();
                } catch (e) {
                    console.warn(`[Peer ${this.id}] Keepalive failed`, e);
                    this.disconnect();
                }
            }
        }, 5000) as unknown as Timer;
    }

    private disconnect() {
        this.isConnected = false;
        clearInterval(this.keepAliveTimer);
        console.log(`[Peer ${this.id}] Disconnected`);
    }

    // --- Incoming RPC Handlers ---

    private async onKeepAlive() {
    }

    public async onUpdateRoute(msg: UpdateMessage) {
        await this.dispatch({
            resource: 'internal-peering-protocol',
            action: 'update',
            data: msg
        });
    }
    */
}
