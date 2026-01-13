import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
// import WebSocket from 'ws'; // Use global WebSocket available in Bun/Browser
import {
    PeerPublicApi,
    AuthorizedPeer,
    PeerClient,
    PeerInfo,
    UpdateMessage,
    PeerSessionState
} from '../rpc/schema/peering.js';

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

    public domains: string[] = [];
    public as: number = 0;

    private session: any; // return type of newWebSocketRpcSession
    private remote: AuthorizedPeer | PeerClient | null = null;
    private keepAliveInterval: any | null = null; // Timer type issue in Bun vs Node
    public localInfo: PeerInfo;
    private clientStub: PeerClientStub;
    private onDisconnect?: () => void;
    private onRouteUpdate?: (msg: UpdateMessage) => void;

    constructor(
        address: string,
        localInfo: PeerInfo,
        onDisconnect?: () => void,
        onRouteUpdate?: (msg: UpdateMessage) => void
    ) {
        this.address = address;
        this.id = address; // temporary ID until handshake? or provided in constructor
        this.localInfo = localInfo;
        this.clientStub = new PeerClientStub(this);
        this.onDisconnect = onDisconnect;
        this.onRouteUpdate = onRouteUpdate;
    }

    setRemoteInfo(info: PeerInfo) {
        this.id = info.id;
        this.domains = info.domains;
        this.as = info.as;
        // Address might be different from endpoint if behind NAT, but use endpoint for now
        // this.address = info.endpoint; 
    }

    // Called when WE accept a connection from THEM
    async accept(remoteInfo: PeerInfo, remoteStub: PeerClient) {
        this.remote = remoteStub;
        this.setRemoteInfo(remoteInfo);

        this.isConnected = true;
        this.lastKeepAlive = Date.now();
        console.log(`[Peer ${this.address}] Accepted connection from ${this.id}`);
        this.startKeepAlive();
    }

    async connect(secret: string, injectedPublicApi?: PeerPublicApi) {
        console.log(`[Peer ${this.address}] Connecting...`);

        let publicApi: PeerPublicApi;

        if (injectedPublicApi) {
            publicApi = injectedPublicApi;
        } else {
            // Default WebSocket Logic
            const url = this.address.startsWith('ws') ? this.address : `ws://${this.address}/rpc`;
            const ws = new WebSocket(url);

            await new Promise<void>((resolve, reject) => {
                const onOpen = () => {
                    console.log(`[Peer ${this.address}] WebSocket Open`);
                    cleanup();
                    resolve();
                };
                const onError = (err: any) => {
                    console.error(`[Peer ${this.address}] WebSocket Error:`, err);
                    cleanup();
                    reject(err);
                };
                const cleanup = () => {
                    ws.removeEventListener('open', onOpen);
                    ws.removeEventListener('error', onError);
                };

                ws.addEventListener('open', onOpen);
                ws.addEventListener('error', onError);

                // Close listener stays for the lifetime
                ws.addEventListener('close', (evt: any) => {
                    console.log(`[Peer ${this.address}] WebSocket Closed: ${evt.code} ${evt.reason}`);
                    this.startDisconnectCleanup();
                });
            });

            // Initialize RPC Session
            // We pass 'this.clientStub' as the local stub, enabling the server to call PeerClient methods on us
            this.session = newWebSocketRpcSession(ws as any, this.clientStub);
            publicApi = this.session as any as PeerPublicApi;
        }

        // Pinging...
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

        if (!state.accepted) {
            console.warn(`[Peer ${this.address}] Valid authentication but connection rejected by peer.`);
            return; // Failed to connect
        }

        if (state.domains) {
            this.domains = state.domains;
        }

        this.isConnected = true;
        this.lastKeepAlive = Date.now();
        console.log(`[Peer ${this.address}] Connected! Authorized: ${state.accepted} Domains: ${this.domains.join(',')}`);

        // Start KeepAlive loop
        this.startKeepAlive();
    }

    private startKeepAlive() {
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = setInterval(() => {
            if (this.isConnected && this.remote) {
                // Ensure remote is valid
                if ('keepAlive' in this.remote) {
                    this.remote.keepAlive().catch(err => {
                        console.error(`[Peer ${this.address}] KeepAlive failed:`, err);
                        this.disconnect();
                    });
                }
            }
        }, 10000); // 10s for now
    }

    async disconnect() {
        if (!this.isConnected) return;

        if (this.remote) {
            try {
                // Determine if remote has close method (it might be PeerClient or AuthorizedPeer)
                // AuthorizedPeer has close, PeerClient (as defined in schema) does NOT have close in interface currently?
                // Wait, PeerClient interface in schema:
                // export interface PeerClient { keepAlive, updateRoute } -- NO CLOSE.

                // So if we accepted a connection, we have a PeerClient stub. We can't tell IT to close?
                // Actually, the server can close the connection by dropping it?
                // Or we should add close to PeerClient too?

                // If we are the Initiator (AuthorizedPeer), we can call close().
                if (this.remote && 'close' in this.remote) {
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

        if (this.session) {
            try {
                this.session.close();
            } catch (e) {
                // Ignore close errors
            }
            this.session = null;
        }

        // Remove from GlobalRouteTable? 
        // If we are the one initiating disconnect, we should probably remove ourselves or the peer from the table.
        if (this.onDisconnect) {
            this.onDisconnect();
        }
        console.log(`[Peer ${this.address}] Disconnected`);
    }

    // ----------------------------------------------------------------
    // PeerClient Implementation (Callbacks from Server)
    // ----------------------------------------------------------------

    async keepAlive(): Promise<void> {
        if (!this.isConnected) throw new Error('Peer disconnected');
        // Heartbeat received from server
        this.lastKeepAlive = Date.now();
        // console.log(`[Peer ${this.address}] Received Heartbeat`);
    }

    async updateRoute(msg: UpdateMessage): Promise<void> {
        if (!this.isConnected) throw new Error('Peer disconnected');
        console.log(`[Peer ${this.address}] Received Update:`, msg);
        if (this.onRouteUpdate) {
            this.onRouteUpdate(msg);
        }
    }

    // Called by RouteTable to Broadcast updates to this Peer
    async sendUpdate(msg: UpdateMessage): Promise<void> {
        if (this.remote && this.isConnected) {
            return this.remote.updateRoute(msg);
        }
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
