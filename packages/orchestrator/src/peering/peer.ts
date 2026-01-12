import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
// import WebSocket from 'ws'; // Use global WebSocket available in Bun/Browser
// import WebSocket from 'ws'; // Use global WebSocket available in Bun/Browser
import {
    PeerPublicApi,
    AuthorizedPeer,
    PeerClient,
    PeerInfo,
    UpdateMessage,
    PeerSessionState
} from '../rpc/schema/peering.js';
import { GlobalRouteTable } from '../state/route-table.js';

class PeerClientStub extends RpcTarget implements PeerClient {
    constructor(private peer: Peer) { super(); }

    async keepAlive(): Promise<void> {
        return this.peer.keepAlive();
    }

    async updateRoute(msg: UpdateMessage): Promise<void> {
        return this.peer.updateRoute(msg);
    }

    async close(): Promise<void> {
        return this.peer.remoteClosed();
    }
}

export class Peer implements PeerClient {
    public id: string;
    public address: string;
    public isConnected: boolean = false;
    public lastKeepAlive: number = 0;

    private session: any; // return type of newWebSocketRpcSession
    private remote: AuthorizedPeer | PeerClient | null = null;
    private keepAliveInterval: any | null = null; // Timer type issue in Bun vs Node
    public localInfo: PeerInfo;
    private clientStub: PeerClientStub;

    constructor(address: string, localInfo: PeerInfo) {
        this.address = address;
        this.id = address; // temporary ID until handshake? or provided in constructor
        this.localInfo = localInfo;
        this.clientStub = new PeerClientStub(this);
    }

    // Called when WE accept a connection from THEM
    async accept(remoteStub: PeerClient, remoteInfo: PeerInfo) {
        this.remote = remoteStub;
        this.id = remoteInfo.id;
        this.address = remoteInfo.endpoint;
        this.isConnected = true;
        this.lastKeepAlive = Date.now();
        console.log(`[Peer ${this.address}] Accepted connection from ${this.id}`);
        this.startKeepAlive();
    }

    async connect(secret: string) {
        console.log(`[Peer ${this.address}] Connecting...`);
        // TODO: Ensure URL format. Assuming address includes protocol or defaults to ws://
        const url = this.address.startsWith('ws') ? this.address : `ws://${this.address}/rpc`;

        // const url = this.address.startsWith('ws') ? this.address : `ws://${this.address}/rpc`;

        // Use global WebSocket (Bun/Browser)
        const ws = new WebSocket(url);

        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', (err) => reject(err));
            ws.addEventListener('close', () => {
                console.log(`[Peer ${this.address}] WebSocket connection closed`);
                this.startDisconnectCleanup();
            });
        });

        // Initialize RPC Session
        // We pass 'this.clientStub' as the local stub, enabling the server to call PeerClient methods on us
        this.session = newWebSocketRpcSession(ws as any, this.clientStub);

        // The session IS the remote stub
        const publicApi = this.session as PeerPublicApi;

        console.log(`[Peer ${this.address}] Pinging...`);
        try {
            const pong = await publicApi.ping();
            console.log(`[Peer ${this.address}] Ping response: ${pong}`);
        } catch (e) {
            console.error(`[Peer ${this.address}] Ping failed:`, e);
        }

        // Pipelined Auth -> Open
        console.log(`[Peer ${this.address}] Authenticating...`);
        // We cast the result to AuthorizedPeer because authenticate returns it
        const authRemote = publicApi.authenticate(secret);
        this.remote = authRemote;

        if (!this.remote) {
            throw new Error('Failed to get authorized peer stub');
        }

        console.log(`[Peer ${this.address}] Opening session...`);
        // Call open on the promise (pipelined)
        const statePromise = authRemote.open(this.localInfo, this.clientStub);

        // Await the result to confirm connection established
        const state = await statePromise;

        this.isConnected = true;
        this.lastKeepAlive = Date.now();
        console.log(`[Peer ${this.address}] Connected! Authorized: ${state.accepted}`);

        // Start KeepAlive loop
        this.startKeepAlive();
    }

    private startKeepAlive() {
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = setInterval(() => {
            if (this.isConnected && this.remote) {
                this.remote.keepAlive().catch(err => {
                    console.error(`[Peer ${this.address}] KeepAlive failed:`, err);
                    this.disconnect();
                });
            }
        }, 10000); // 10s for now
    }

    async disconnect() {
        if (this.remote && this.isConnected) {
            try {
                // Determine if remote has close method (it might be PeerClient or AuthorizedPeer)
                // AuthorizedPeer has close, PeerClient (as defined in schema) does NOT have close in interface currently?
                // Wait, PeerClient interface in schema:
                // export interface PeerClient { keepAlive, updateRoute } -- NO CLOSE.

                // So if we accepted a connection, we have a PeerClient stub. We can't tell IT to close?
                // Actually, the server can close the connection by dropping it?
                // Or we should add close to PeerClient too?

                // If we are the Initiator (AuthorizedPeer), we can call close().
                if ('close' in this.remote) {
                    await (this.remote as AuthorizedPeer).close();
                }
            } catch (e) {
                console.warn(`[Peer ${this.address}] Failed to send close:`, e);
            }
        }
        this.startDisconnectCleanup();
    }

    private startDisconnectCleanup() {
        this.isConnected = false;
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);

        // Remove from GlobalRouteTable? 
        // If we are the one initiating disconnect, we should probably remove ourselves or the peer from the table.
        GlobalRouteTable.removePeer(this.id);
        console.log(`[Peer ${this.address}] Disconnected`);
    }

    // ----------------------------------------------------------------
    // PeerClient Implementation (Callbacks from Server)
    // ----------------------------------------------------------------

    async keepAlive(): Promise<void> {
        // Heartbeat received from server
        this.lastKeepAlive = Date.now();
        // console.log(`[Peer ${this.address}] Received Heartbeat`);
    }

    async updateRoute(msg: UpdateMessage): Promise<void> {
        console.log(`[Peer ${this.address}] Received Update:`, msg);
        // GlobalRouteTable.processUpdate(msg); // RouteTable update method implementation pending
        // For now, valid placeholder
    }

    // Called when the REMOTE peer calls close() on us (Server -> Client)
    async remoteClosed(): Promise<void> {
        console.log(`[Peer ${this.address}] Remote side closed connection`);
        this.startDisconnectCleanup();
    }

    // Called when WE receive a close request via RPC (PeerClient interface)
    // Wait, PeerClient interface says close().
    // So if the server calls clientStub.close(), it maps to PeerClientStub.close() which calls this.peer.remoteClosed().
    // We should also implement close() to satisfy PeerClient interface if 'this' was used directly, 
    // but we use PeerClientStub. 
    // However, the class `Peer` implements `PeerClient`. So it must match the interface.
    async close(): Promise<void> {
        return this.remoteClosed();
    }
}
