import { RpcTarget } from 'capnweb'
import { type Action } from './schema.js'
import type { PeerInfo } from './routing/state.js'
import { newRouteTable, type RouteTable } from './routing/state.js'
import {
    newHttpBatchRpcSession,
    newWebSocketRpcSession,
    type RpcCompatible,
    type RpcStub,
} from 'capnweb'
// Interface for classes that need to emit actions
export interface PublicApi {
    getManagerConnection(): PeerManager
    getPeerConnection(
        secret: string
    ): { success: true; connection: PeerConnection } | { success: false; error: string }
}

export interface PeerManager {
    addPeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
    updatePeer(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
    removePeer(
        peer: Pick<PeerInfo, 'name'>
    ): Promise<{ success: true } | { success: false; error: string }>
}

export interface PeerConnection {
    open(peer: PeerInfo): Promise<{ success: true } | { success: false; error: string }>
    close(peer: PeerInfo, code: number, reason?: string): Promise<{ success: true } | { success: false; error: string }>
}

export function getHttpPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
    return newHttpBatchRpcSession<API>(endpoint)
}

export function getWebSocketPeerSession<API extends RpcCompatible<API>>(endpoint: string) {
    return newWebSocketRpcSession<API>(endpoint)
}

export class ConnectionPool {
    private stubs: Map<string, RpcStub<PublicApi>>
    constructor(private type: 'ws' | 'http' = 'http') {
        this.stubs = new Map<string, RpcStub<PublicApi>>()
    }

    get(endpoint: string) {
        if (this.stubs.has(endpoint)) {
            return this.stubs.get(endpoint)
        }
        switch (this.type) {
            case 'http': {
                const stub = newHttpBatchRpcSession<PublicApi>(endpoint)
                this.stubs.set(endpoint, stub)
                return stub
            }
            case 'ws': {
                const stub = newWebSocketRpcSession<PublicApi>(endpoint)
                this.stubs.set(endpoint, stub)
                return stub
            }
        }
    }
}

export class CatalystNodeBus extends RpcTarget {
    private state: RouteTable
    private connectionPool: ConnectionPool
    constructor(opts: {
        state?: RouteTable
        connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
    }) {
        super()
        this.state = opts.state ?? newRouteTable()
        this.connectionPool =
            opts.connectionPool?.pool ??
            (opts.connectionPool?.type
                ? new ConnectionPool(opts.connectionPool.type)
                : new ConnectionPool())
    }

    async dispatch(
        sentAction: Action
    ): Promise<{ success: true } | { success: false; error: string }> {
        const prevState = this.state
        const result = await this.handleAction(sentAction, this.state)
        if (result.success) {
            this.state = result.state
            // Fire notifications/side-effects after state update
            await this.handleNotify(sentAction, result.state, prevState)
            return { success: true }
        }
        return result
    }

    async handleAction(
        action: Action,
        state: RouteTable
    ): Promise<{ success: true; state: RouteTable } | { success: false; error: string }> {
        switch (action.action) {
            case 'local:peer:create': {
                const peerList = state.internal.peers
                if (peerList.find((p) => p.name === action.data.name)) {
                    return { success: false, error: 'Peer already exists' }
                }

                // Optimistically add peer as initializing
                let newState = {
                    ...state,
                    internal: {
                        routes: state.internal.routes,
                        peers: [
                            ...state.internal.peers,
                            {
                                name: action.data.name,
                                endpoint: action.data.endpoint,
                                domains: action.data.domains,
                                connectionStatus: 'initializing' as const,
                                lastConnected: undefined,
                            },
                        ],
                    },
                }

                state = newState;
                break
            }
            case 'local:peer:update': {
                const peerList = state.internal.peers
                const peer = peerList.find((p) => p.name === action.data.name)
                if (!peer) {
                    return { success: false, error: 'Peer not found' }
                }
                state = {
                    ...state,
                    internal: {
                        routes: state.internal.routes,
                        peers: peerList.map((p) =>
                            p.name === action.data.name
                                ? {
                                    ...p,
                                    endpoint: action.data.endpoint,
                                    domains: action.data.domains,
                                    connectionStatus: 'initializing',
                                    lastConnected: undefined,
                                }
                                : p
                        ),
                    },
                }
                break
            }
            case 'local:peer:delete': {
                const peerList = state.internal.peers
                const peer = peerList.find((p) => p.name === action.data.name)
                if (!peer) {
                    return { success: false, error: 'Peer not found' }
                }
                state = {
                    ...state,
                    internal: {
                        routes: state.internal.routes,
                        peers: peerList.filter((p) => p.name !== action.data.name),
                    },
                }
                break
            }
            case 'internal:protocol:close': {
                const peerList = state.internal.peers
                // Find peer by matching info from sender
                const peer = peerList.find(p => p.name === action.data.peerInfo.name)

                // If found, remove it. If not found, it's already gone or never existed.
                if (peer) {
                    state = {
                        ...state,
                        internal: {
                            routes: state.internal.routes,
                            peers: peerList.filter(p => p.name !== action.data.peerInfo.name)
                        }
                    }
                }
                break;
            }
            case 'internal:protocol:open': {
                const peer = state.internal.peers.find(p => p.name === action.data.peerInfo.name)
                if (!peer) {
                    return { success: false, error: 'Peer not configured' }
                }

                // We could validte endpoints here too

                if (peer.connectionStatus !== 'connected') {
                    state = {
                        ...state,
                        internal: {
                            ...state.internal,
                            peers: state.internal.peers.map(p => p.name === action.data.peerInfo.name ? { ...p, connectionStatus: 'connected' } : p)
                        }
                    }
                }
                break;
            }
            case 'internal:protocol:connected': {
                const peerList = state.internal.peers
                const peer = peerList.find((p) => p.name === action.data.peerInfo.name)
                if (peer) {
                    state = {
                        ...state,
                        internal: {
                            ...state.internal,
                            peers: state.internal.peers.map(p => p.name === action.data.peerInfo.name ? { ...p, connectionStatus: 'connected' } : p)
                        }
                    }
                }
                break
            }
            default: {
                console.log('Unknown action', action)
                break
            }
        }

        return { success: true, state }
    }

    async handleNotify(
        action: Action,
        _state: RouteTable,
        prevState: RouteTable
    ): Promise<void> {
        switch (action.action) {
            case 'local:peer:create': {
                // Perform side effect: Try to open connection
                try {
                    const stub = this.connectionPool.get(action.data.endpoint)
                    if (stub) {
                        const connectionResult = await stub.getPeerConnection("secret")
                        if (connectionResult.success) {
                            const result = await connectionResult.connection.open({
                                name: "myself", // TODO: Configured local name
                                endpoint: "http://localhost:3000", // TODO: Configured local endpoint
                                domains: [] // TODO: Configured local domains
                            })

                            if (result.success) {
                                // Dispatch connected action
                                await this.dispatch({
                                    action: 'internal:protocol:connected',
                                    data: { peerInfo: action.data }
                                })
                            }
                        } else {
                            console.error("Failed to get peer connection", connectionResult.error)
                        }
                    }
                } catch (e) {
                    // Connection failed, leave as initializing (or could transition to error state)
                    console.error("Failed to open connection", e)
                }
                break
            }
            case 'local:peer:delete': {
                // Use prevState to find the peer info that was just deleted
                const peer = prevState.internal.peers.find(p => p.name === action.data.name)
                if (peer) {
                    try {
                        const stub = this.connectionPool.get(peer.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.close(
                                    {
                                        name: "myself", // TODO: Configured local name
                                        endpoint: "http://localhost:3000",
                                        domains: []
                                    },
                                    1000,
                                    "Peer removed"
                                )
                            }
                        }
                    } catch (e) {
                        console.error("Failed to close connection", e)
                    }
                }
                break
            }
        }
    }

    publicApi(): PublicApi {
        return {
            getManagerConnection: (): PeerManager => {
                return {
                    addPeer: async (peer: PeerInfo) => {
                        console.log('addPeer', peer)
                        return this.dispatch({
                            action: 'local:peer:create',
                            data: peer,
                        })
                    },
                    updatePeer: async (peer: PeerInfo) => {
                        console.log('updatePeer', peer)
                        return this.dispatch({
                            action: 'local:peer:update',
                            data: peer,
                        })
                    },
                    removePeer: async (peer: Omit<PeerInfo, 'endpoint' | 'domains'>) => {
                        console.log('removePeer', peer)
                        return this.dispatch({
                            action: 'local:peer:delete',
                            data: peer,
                        })
                    },
                }
            },
            getPeerConnection: (
                _secret: string
            ): { success: true; connection: PeerConnection } | { success: false; error: string } => {
                return {
                    success: true,
                    connection: {
                        open: async (peer: PeerInfo) => {
                            return this.dispatch({
                                action: 'internal:protocol:open',
                                data: { peerInfo: peer }
                            })
                        },
                        close: async (peer: PeerInfo, code: number, reason?: string) => {
                            return this.dispatch({
                                action: 'internal:protocol:close',
                                data: { peerInfo: peer, code, reason }
                            })
                        }
                    }
                }
            },
        }
    }
}
