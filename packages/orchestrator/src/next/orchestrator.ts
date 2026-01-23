import type { z } from 'zod'
import { type Action } from './schema.js'
import type { PeerInfo } from './routing/state.js'
import { newRouteTable, type RouteTable } from './routing/state.js'
import type { UpdateMessageSchema } from './routing/internal/actions.js'
import {
    newHttpBatchRpcSession,
    newWebSocketRpcSession,
    type RpcCompatible,
    type RpcStub,
    RpcTarget,
} from 'capnweb'

export interface PublicApi {
    getManagerConnection(): PeerManager
    getPeerConnection(
        secret: string
    ): { success: true; connection: PeerConnection } | { success: false; error: string }
    getInspector(): Inspector
    dispatch(action: Action): Promise<{ success: true } | { success: false; error: string }>
}

export interface Inspector {
    listPeers(): Promise<PeerInfo[]>
    listRoutes(): Promise<{ local: any[], internal: any[] }>
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
    close(
        peer: PeerInfo,
        code: number,
        reason?: string
    ): Promise<{ success: true } | { success: false; error: string }>
    update(
        peer: PeerInfo,
        update: z.infer<typeof UpdateMessageSchema>
    ): Promise<{ success: true } | { success: false; error: string }>
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
    private config?: { ibgp?: { secret?: string } }

    constructor(opts: {
        state?: RouteTable
        connectionPool?: { type?: 'ws' | 'http'; pool?: ConnectionPool }
        config?: { ibgp?: { secret?: string } }
    }) {
        super()
        this.state = opts.state ?? newRouteTable()
        this.config = opts.config
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

                state = {
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
                const peer = peerList.find(p => p.name === action.data.peerInfo.name)
                if (peer) {
                    state = {
                        ...state,
                        internal: {
                            routes: state.internal.routes.filter(r => r.peerName !== action.data.peerInfo.name),
                            peers: peerList.filter(p => p.name !== action.data.peerInfo.name)
                        }
                    }
                }
                break
            }
            case 'internal:protocol:open': {
                const peer = state.internal.peers.find(p => p.name === action.data.peerInfo.name)
                if (!peer) {
                    return { success: false, error: `Peer '${action.data.peerInfo.name}' is not configured on this node` }
                }

                if (peer.connectionStatus !== 'connected') {
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
            case 'local:route:create': {
                if (state.local.routes.find(r => r.name === action.data.name)) {
                    return { success: false, error: 'Route already exists' }
                }
                state = {
                    ...state,
                    local: {
                        ...state.local,
                        routes: [...state.local.routes, action.data]
                    }
                }
                break
            }
            case 'local:route:delete': {
                if (!state.local.routes.find(r => r.name === action.data.name)) {
                    return { success: false, error: 'Route not found' }
                }
                state = {
                    ...state,
                    local: {
                        ...state.local,
                        routes: state.local.routes.filter(r => r.name !== action.data.name)
                    }
                }
                break
            }
            case 'internal:protocol:update': {
                const peerInfo = action.data.peerInfo
                let currentInternalRoutes = [...state.internal.routes]

                for (const update of action.data.update.updates) {
                    if (update.action === 'add') {
                        const routeToAdd = { ...update.route, peer: peerInfo, peerName: peerInfo.name }
                        currentInternalRoutes = currentInternalRoutes.filter(r => !(r.name === update.route.name && r.peerName === peerInfo.name))
                        currentInternalRoutes.push(routeToAdd)
                    } else if (update.action === 'remove') {
                        currentInternalRoutes = currentInternalRoutes.filter(r => !(r.name === update.route.name && r.peerName === peerInfo.name))
                    }
                }

                state = {
                    ...state,
                    internal: {
                        ...state.internal,
                        routes: currentInternalRoutes,
                    },
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
                try {
                    const stub = this.connectionPool.get(action.data.endpoint)
                    if (stub) {
                        const connectionResult = await stub.getPeerConnection("secret")
                        if (connectionResult.success) {
                            const result = await connectionResult.connection.open(this.myself)
                            if (result.success) {
                                await this.dispatch({
                                    action: 'internal:protocol:connected',
                                    data: { peerInfo: action.data }
                                })
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[${this.myself.name}] Failed to open connection to ${action.data.name}`, e)
                }
                break
            }
            case 'internal:protocol:open': {
                for (const route of _state.local.routes) {
                    try {
                        const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.update(this.myself, {
                                    updates: [{ action: 'add', route }]
                                })
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to sync route back to ${action.data.peerInfo.name}`, e)
                    }
                }
                break
            }
            case 'internal:protocol:connected': {
                for (const route of _state.local.routes) {
                    try {
                        const stub = this.connectionPool.get(action.data.peerInfo.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.update(this.myself, {
                                    updates: [{ action: 'add', route }]
                                })
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to sync route to ${action.data.peerInfo.name}`, e)
                    }
                }
                break
            }
            case 'local:peer:delete': {
                const peer = prevState.internal.peers.find(p => p.name === action.data.name)
                if (peer) {
                    try {
                        const stub = this.connectionPool.get(peer.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.close(this.myself, 1000, "Peer removed")
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to close connection to ${peer.name}`, e)
                    }
                }
                break
            }
            case 'local:route:create': {
                for (const peer of _state.internal.peers.filter(p => p.connectionStatus === 'connected')) {
                    try {
                        const stub = this.connectionPool.get(peer.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.update(this.myself, {
                                    updates: [{ action: 'add', route: action.data }]
                                })
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to broadcast route to ${peer.name}`, e)
                    }
                }
                break
            }
            case 'local:route:delete': {
                for (const peer of _state.internal.peers.filter(p => p.connectionStatus === 'connected')) {
                    try {
                        const stub = this.connectionPool.get(peer.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.update(this.myself, {
                                    updates: [{ action: 'remove', route: action.data }]
                                })
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to broadcast route removal to ${peer.name}`, e)
                    }
                }
                break
            }
            case 'internal:protocol:update': {
                const sourcePeerName = action.data.peerInfo.name
                for (const peer of _state.internal.peers.filter(p => p.connectionStatus === 'connected' && p.name !== sourcePeerName)) {
                    try {
                        const stub = this.connectionPool.get(peer.endpoint)
                        if (stub) {
                            const connectionResult = await stub.getPeerConnection("secret")
                            if (connectionResult.success) {
                                await connectionResult.connection.update(this.myself, action.data.update)
                            }
                        }
                    } catch (e) {
                        console.error(`[${this.myself.name}] Failed to propagate update to ${peer.name}`, e)
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
                        return this.dispatch({
                            action: 'local:peer:create',
                            data: peer,
                        })
                    },
                    updatePeer: async (peer: PeerInfo) => {
                        return this.dispatch({
                            action: 'local:peer:update',
                            data: peer,
                        })
                    },
                    removePeer: async (peer: Pick<PeerInfo, 'name'>) => {
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
                        },
                        update: async (peer: PeerInfo, update: z.infer<typeof UpdateMessageSchema>) => {
                            return this.dispatch({
                                action: 'internal:protocol:update',
                                data: {
                                    peerInfo: peer,
                                    update: update
                                }
                            })
                        },
                    },
                }
            },
            getInspector: (): Inspector => {
                return {
                    listPeers: async () => this.state.internal.peers,
                    listRoutes: async () => ({
                        local: this.state.local.routes,
                        internal: this.state.internal.routes
                    }),
                }
            },
            dispatch: async (action: Action) => {
                return this.dispatch(action)
            },
        }
    }
}
