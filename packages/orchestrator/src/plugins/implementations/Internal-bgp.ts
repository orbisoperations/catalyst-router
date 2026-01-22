import { Action } from '../../rpc/schema/actions.js';
import { BasePlugin } from '../../plugins/base.js';
import { PluginContext, PluginResult } from '../../plugins/types.js';
import { z } from 'zod';
import { newHttpBatchRpcSession } from 'capnweb';
import { getConfig } from '../../config.js';

export class InternalBGPPlugin extends BasePlugin {
    name = 'InternalBGPPlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action } = context;

        if (action.resource === 'internalPeerConfig' && action.resourceAction === 'create') {
            return this.handleCreatePeer(context);
        }

        if (action.resource === 'internalPeerSession' && action.resourceAction === 'open') {
            return this.handleOpenPeer(context);
        }

        if (action.resource === 'internalPeerSession' && action.resourceAction === 'close') {
            return this.handleClosePeer(context);
        }

        if (action.resource === 'internalBGPRoute' && action.resourceAction === 'update') {
            return this.handleRouteUpdate(context);
        }

        if (action.resource === 'localRoute' && (action.resourceAction === 'create' || action.resourceAction === 'delete')) {
            return this.broadcastRouteUpdate(context);
        }

        return { success: true, ctx: context };
    }

    private async handleCreatePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { endpoint } = data;

        const existingPeers = context.state.getPeers();
        if (existingPeers.some(p => p.endpoint === endpoint)) {
            console.log(`[InternalAS] Peer at ${endpoint} already exists. Skipping.`);
            return { success: true, ctx: context };
        }

        console.log(`[InternalAS] Registering peer at ${endpoint}`);

        const peerData = {
            id: `peer-${endpoint.replace(/[^a-zA-Z0-9]/g, '-')}`,
            as: 0,
            endpoint: endpoint,
            domains: []
        };

        const { state: newState } = context.state.addPeer(peerData);
        context.state = newState;

        // Trigger synchronization immediately when a peer is configured
        setImmediate(() => {
            this.syncExistingRoutesToPeer(context, peerData.id).catch(e => {
                console.error(`[InternalAS] Initial sync failed for ${peerData.id}:`, e.message);
            });
        });

        return { success: true, ctx: context };
    }

    private async handleOpenPeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerInfo } = data;

        console.log(`[InternalAS] Handling OPEN request from ${peerInfo.id}`);

        const existingPeers = context.state.getPeers();
        const existingByEndpoint = existingPeers.find(p => p.endpoint === peerInfo.endpoint);

        let newState = context.state;
        if (existingByEndpoint && existingByEndpoint.id !== peerInfo.id) {
            console.log(`[InternalAS] Unifying peer ID for ${peerInfo.endpoint}: ${existingByEndpoint.id} -> ${peerInfo.id}`);
            newState = newState.removePeer(existingByEndpoint.id);
        }

        // Simplification: If peer already exists, we are done (prevents infinite loops)
        if (newState.getPeer(peerInfo.id)) {
            console.log(`[InternalAS] Peer ${peerInfo.id} already exists in state.`);
            return { success: true, ctx: { ...context, state: newState } };
        }

        const authorizedPeer = {
            id: peerInfo.id,
            as: peerInfo.as,
            endpoint: peerInfo.endpoint || 'unknown',
            domains: peerInfo.domains || []
        };

        const { state: updatedState } = newState.addPeer(authorizedPeer);
        context.state = updatedState;

        console.log(`[InternalAS] Peer ${peerInfo.id} registered.`);

        // Synchronize in background to allow the OPEN call to complete
        setImmediate(() => {
            this.syncExistingRoutesToPeer(context, peerInfo.id).catch(e => {
                console.error(`[InternalAS] Background sync failed for ${peerInfo.id}:`, e.message);
            });
        });

        return { success: true, ctx: context };
    }

    private async syncExistingRoutesToPeer(context: PluginContext, peerId: string): Promise<void> {
        const start = Date.now();
        const peer = context.state.getPeer(peerId);
        if (!peer || !peer.endpoint || peer.endpoint === 'unknown') return;

        const routes = context.state.getAllRoutes();
        console.log(`[InternalAS] syncExistingRoutesToPeer: Peer=${peerId}, RouteCount=${routes.length}`);

        try {
            const config = getConfig();
            const sharedSecret = config.peering.secret;
            const myPeerInfo = {
                id: config.peering.localId || 'unknown',
                as: config.peering.as,
                domains: config.peering.domains,
                services: [],
                endpoint: config.peering.endpoint || null
            };

            const session: any = newHttpBatchRpcSession(peer.endpoint);
            const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);

            // Always start with OPEN to ensure bidirectional handshake
            // Don't await it here, let it batch with updates for stateless RPC to work
            const openPromise = ibgpScope.open(myPeerInfo);

            if (routes.length > 0) {
                let lastPromise: Promise<any> | null = null;
                for (const route of routes) {
                    console.log(`[InternalAS] --> Syncing ${route.service.name} to ${peerId}`);
                    lastPromise = ibgpScope.update({
                        type: 'add',
                        route: route.service
                    });
                }
                // Await the last one to flush everything
                if (lastPromise) await lastPromise;
                else await openPromise;
            } else {
                await openPromise;
            }

            console.log(`[InternalAS] Sync to ${peerId} completed in ${Date.now() - start}ms.`);
        } catch (e: any) {
            console.error(`[InternalAS] Failed to sync to peer ${peerId} at ${peer?.endpoint}:`, e.message);
        }
    }

    private async sendIndividualUpdate(context: PluginContext, peerId: string, updateMsg: any): Promise<void> {
        const peer = context.state.getPeer(peerId);
        if (!peer || !peer.endpoint || peer.endpoint === 'unknown') return;

        try {
            const config = getConfig();
            const sharedSecret = config.peering.secret;
            const myPeerInfo = {
                id: config.peering.localId || 'unknown',
                as: config.peering.as,
                domains: config.peering.domains,
                services: [],
                endpoint: config.peering.endpoint || null
            };

            const session: any = newHttpBatchRpcSession(peer.endpoint);
            const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);
            // Batch open and update together
            ibgpScope.open(myPeerInfo);
            await ibgpScope.update(updateMsg);
        } catch (e: any) {
            console.error(`[InternalAS] Failed to send update to peer ${peerId} at ${peer.endpoint}:`, e.message);
        }
    }

    private async handleClosePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerId, skipNotify } = data;
        console.log(`[InternalAS] Handling CLOSE request for ${peerId}`);

        if (!skipNotify) {
            await this.notifyPeerClose(context, peerId);
        }

        const newState = context.state.removePeer(peerId);
        context.state = newState;
        return { success: true, ctx: context };
    }

    private async notifyPeerClose(context: PluginContext, peerId: string): Promise<void> {
        const peer = context.state.getPeer(peerId);
        if (!peer || !peer.endpoint || peer.endpoint === 'unknown') return;

        try {
            console.log(`[InternalAS] Notifying peer ${peerId} of closure at ${peer.endpoint}`);
            const config = getConfig();
            const sharedSecret = config.peering.secret;
            const myPeerInfo = {
                id: config.peering.localId || 'unknown',
                as: config.peering.as,
                domains: config.peering.domains,
                services: [],
                endpoint: config.peering.endpoint || null
            };

            const session: any = newHttpBatchRpcSession(peer.endpoint);
            const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);
            await ibgpScope.open(myPeerInfo);
            await ibgpScope.close();
            console.log(`[InternalAS] Successfully notified peer ${peerId} of closure.`);
        } catch (e: any) {
            console.error(`[InternalAS] Failed to notify peer ${peerId} of closure:`, e.message);
        }
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

        const peers = context.state.getPeers();
        console.log(`[InternalAS] Broadcasting ${updateType} to ${peers.length} peers via Batch HTTP RPC.`);

        const promises = peers.map((peer) => this.sendIndividualUpdate(context, peer.id, updateMsg));

        await Promise.all(promises);
        return { success: true, ctx: context };
    }

    private async handleRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { type, route, routeId } = data;
        const sourcePeerId = data.sourcePeerId || 'unknown';

        console.log(`[InternalAS] Handling BGP UPDATE: ${type} ${route?.name || routeId} from ${sourcePeerId}`);

        let newState = context.state;
        if (type === 'add' && route) {
            const res = newState.addInternalRoute(route, sourcePeerId);
            newState = res.state;
        } else if (type === 'remove' && routeId) {
            newState = newState.removeRoute(routeId);
        }

        console.log(`[InternalAS] Route table updated. Total routes: ${newState.getRoutes().length}`);

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
        peerId: z.string(),
        skipNotify: z.boolean().optional()
    })
});

export const InternalPeerSessionKeepAliveSchema = z.object({
    resource: z.literal('internalPeerSession'),
    resourceAction: z.literal('keepAlive'),
    data: z.object({
        peerId: z.string()
    })
});

export const InternalBGPRouteUpdateSchema = z.object({
    resource: z.literal('internalBGPRoute'),
    resourceAction: z.literal('update'),
    data: z.object({
        type: z.union([z.literal('add'), z.literal('remove')]),
        route: z.any().optional(),
        routeId: z.string().optional(),
        sourcePeerId: z.string().optional()
    })
});

export const InternalPeeringActionsSchema = z.union([
    InternalPeerConfigCreateSchema,
    InternalPeerSessionOpenSchema,
    InternalPeerSessionCloseSchema,
    InternalPeerSessionKeepAliveSchema,
    InternalBGPRouteUpdateSchema
]);
