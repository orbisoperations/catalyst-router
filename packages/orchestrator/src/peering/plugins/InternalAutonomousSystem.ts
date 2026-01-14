
import { BasePlugin } from '../../plugins/base.js';
import { PluginContext, PluginResult } from '../../plugins/types.js';
import { z } from 'zod';

export class InternalAutonomousSystemPlugin extends BasePlugin {
    name = 'InternalAutonomousSystemPlugin';

    // Connection pool: Peer ID -> Connection State
    private activePeers: Map<string, { stub: any, endpoint: string, secret: string }> = new Map();
    // Keep references to sessions to prevent GC/Closure
    private sessions: any[] = [];

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        if (action.resource === 'internalPeerConfig' && action.resourceAction === 'create') {
            return this.handleCreatePeer(context);
        }

        if (action.resource === 'internalPeerSession' && action.resourceAction === 'open') {
            return this.handleOpenPeer(context);
        }

        if (action.resource === 'internalPeerSession' && action.resourceAction === 'close') {
            return this.handleClosePeer(context);
        }

        if (action.resource === 'internalPeerSession' && action.resourceAction === 'keepAlive') {
            return this.handleKeepAlive(context);
        }

        if (action.resource === 'internalBGPRoute' && action.resourceAction === 'update') {
            return this.handleRouteUpdate(context);
        }

        if (action.resource === 'localRoute' && (action.resourceAction === 'create' || action.resourceAction === 'delete')) {
            return this.broadcastRouteUpdate(context);
        }

        return { success: true, ctx: context };
    }

    private updateLastSeen(peerId: string) {
        this.peerTimers.set(peerId, Date.now());
    }

    private async handleKeepAlive(context: PluginContext): Promise<PluginResult> {
        const { peerId } = context.action.data;
        // console.log(`[InternalAS] Received KeepAlive from ${peerId}`);
        this.updateLastSeen(peerId);
        return { success: true, ctx: context };
    }

    // Track Last Seen
    private peerTimers: Map<string, number> = new Map();
    // Track Intervals
    private peerIntervals: Map<string, Timer> = new Map();

    private async connectPeer(endpoint: string, secret: string, context: PluginContext): Promise<void> {
        console.log(`[InternalAS] Initiating connection to ${endpoint}`);
        try {
            const { newWebSocketRpcSession } = await import('capnweb');
            const remoteServer = newWebSocketRpcSession(endpoint);
            this.sessions.push(remoteServer);

            // @ts-ignore
            const authorizedPeer = await remoteServer.authorize(secret);

            const localInfo = {
                id: process.env.CATALYST_NODE_ID || 'unknown-node',
                as: parseInt(process.env.CATALYST_AS || '0')
            };

            const localStub = {
                keepAlive: async () => { console.log('[InternalAS] Received KeepAlive'); },
                updateRoute: async (msg: any) => { console.log('[InternalAS] Received Update', msg); }
            };

            const sessionState = await authorizedPeer.open(localInfo, localStub);
            console.log(`[InternalAS] Peer Connected! Accepted: ${sessionState.accepted}`);

            const remotePeerId = sessionState.peerInfo?.id || sessionState.peerId || 'unknown-remote';

            // Store with config for reconnection
            this.activePeers.set(remotePeerId, { stub: authorizedPeer, endpoint, secret });

            if (sessionState.peerInfo) {
                const authorizedPeerData = {
                    id: sessionState.peerInfo.id,
                    as: sessionState.peerInfo.as,
                    endpoint: endpoint,
                    domains: [],
                    _stub: authorizedPeer
                };
                const { state: newState } = context.state.addPeer(authorizedPeerData);
                context.state = newState;
                console.log(`[InternalAS] Outbound Peer ${remotePeerId} registered.`);
            } else {
                console.warn(`[InternalAS] Connected to ${endpoint} but received no Peer Info.`);
            }

        } catch (error: any) {
            console.error(`[InternalAS] Connection failed to ${endpoint}:`, error);
            throw error;
        }
    }

    private async handleCreatePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { endpoint, secret } = data;

        try {
            await this.connectPeer(endpoint, secret, context);
        } catch (error: any) {
            return {
                success: false,
                error: {
                    pluginName: this.name,
                    message: `Failed to connect to peer: ${error.message}`,
                    error
                }
            };
        }
        return { success: true, ctx: context };
    }

    private async handleOpenPeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerInfo, clientStub, direction } = data;

        console.log(`[InternalAS] Handling OPEN request from ${peerInfo.id} (${direction})`);

        const authorizedPeer = {
            id: peerInfo.id,
            as: peerInfo.as,
            endpoint: peerInfo.endpoint || 'unknown',
            domains: peerInfo.domains || [],
            _stub: clientStub
        };

        const { state: newState } = context.state.addPeer(authorizedPeer);
        context.state = newState;

        // Store stub (inbound connections don't have secret/endpoint for reconnection usually, unless we learn it)
        this.activePeers.set(peerInfo.id, { stub: clientStub, endpoint: '', secret: '' });

        console.log(`[InternalAS] Peer ${peerInfo.id} registered. Active Peers: ${this.activePeers.size}`);
        return { success: true, ctx: context };
    }

    private async handleClosePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerId } = data;
        console.log(`[InternalAS] Handling CLOSE request for ${peerId}`);
        const peerRecord = this.activePeers.get(peerId);
        if (peerRecord && peerRecord.stub) {
            try {
                const localId = process.env.CATALYST_NODE_ID || 'unknown-node';
                console.log(`[InternalAS] Sending close to remote peer ${peerId}`);
                await peerRecord.stub.close(localId);
            } catch (e: any) {
                console.warn(`[InternalAS] Failed to notify peer ${peerId} of close:`, e.message);
            }
        }
        this.activePeers.delete(peerId);
        const newState = context.state.removePeer(peerId);
        context.state = newState;
        console.log(`[InternalAS] Peer ${peerId} and its routes removed. Active Peers: ${this.activePeers.size}`);
        return { success: true, ctx: context };
    }

    private async broadcastRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const updateType = action.resourceAction === 'create' ? 'add' : 'remove';
        let updateMsg: any = {
            type: updateType
        };

        if (updateType === 'add') {
            updateMsg.route = action.data;
        } else {
            updateMsg.routeId = action.data.id;
        }

        console.log(`[InternalAS] Broadcasting ${updateType} to ${this.activePeers.size} peers.`);

        const promises: Promise<void>[] = [];
        for (const [peerId, record] of this.activePeers) {
            const stub = record.stub;

            const p = (async () => {
                try {
                    // Try update
                    if (stub && stub.updateRoute) {
                        await stub.updateRoute(updateMsg);
                    }
                } catch (e: any) {
                    // Check for "disposed" error (or any error suggesting disconnection)
                    if (e.message?.includes('disposed') && record.endpoint) {
                        console.warn(`[InternalAS] Peer ${peerId} disposed. Attempting reconnection...`);
                        try {
                            await this.connectPeer(record.endpoint, record.secret, context);
                            // Retry update on NEW stub
                            const newRecord = this.activePeers.get(peerId);
                            if (newRecord && newRecord.stub && newRecord.stub.updateRoute) {
                                await newRecord.stub.updateRoute(updateMsg);
                                console.log(`[InternalAS] Reconnected and updated peer ${peerId}`);
                            }
                        } catch (reconnectErr: any) {
                            console.error(`[InternalAS] Failed to reconnect to ${peerId}:`, reconnectErr.message);
                        }
                    } else {
                        console.error(`[InternalAS] Failed to update peer ${peerId}:`, e.message);
                    }
                }
            })();
            promises.push(p);
        }

        await Promise.all(promises);
        return { success: true, ctx: context };
    }

    private async handleRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { type, route, routeId } = data;

        console.log(`[InternalAS] Handling BGP UPDATE: ${type} ${route?.name || routeId}`);

        const sourcePeerId = data.sourcePeerId || 'unknown';

        let newState = context.state;
        if (type === 'add' && route) {
            const res = newState.addInternalRoute(route, sourcePeerId);
            newState = res.state;
        } else if (type === 'remove' && routeId) {
            newState = newState.removeRoute(routeId);
        }

        context.state = newState;
        return { success: true, ctx: context };
    }
}

export const InternalPeerConfigCreateSchema = z.object({
    resource: z.literal('internalPeerConfig'),
    resourceAction: z.literal('create'),
    data: z.object({
        endpoint: z.string(),
        secret: z.string()
    })
});

export const InternalPeerSessionOpenSchema = z.object({
    resource: z.literal('internalPeerSession'),
    resourceAction: z.literal('open'),
    data: z.object({
        peerInfo: z.any(),
        clientStub: z.any(),
        direction: z.enum(['inbound', 'outbound']).optional()
    })
});

export const InternalPeerSessionCloseSchema = z.object({
    resource: z.literal('internalPeerSession'),
    resourceAction: z.literal('close'),
    data: z.object({
        peerId: z.string()
    })
});

export const InternalPeerSessionKeepAliveSchema = z.object({
    resource: z.literal('internalPeerSession'),
    resourceAction: z.literal('keepAlive'),
    data: z.object({
        peerId: z.string()
    })
});

// BGP Update Message Structure
export const InternalBGPRouteUpdateSchema = z.object({
    resource: z.literal('internalBGPRoute'),
    resourceAction: z.literal('update'),
    data: z.object({
        type: z.union([z.literal('add'), z.literal('remove')]),
        route: z.any().optional(), // ServiceDefinitionSchema
        routeId: z.string().optional(),
        sourcePeerId: z.string().optional() // Injected by dispatcher
    })
});

export const InternalPeeringActionsSchema = z.union([
    InternalPeerConfigCreateSchema,
    InternalPeerSessionOpenSchema,
    InternalPeerSessionCloseSchema,
    InternalPeerSessionKeepAliveSchema,
    InternalBGPRouteUpdateSchema
]);
