
import { BasePlugin } from '../../plugins/base.js';
import { PluginContext, PluginResult } from '../../plugins/types.js';
import { z } from 'zod';

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

        // Idempotency check: If endpoint already exists as a peer, skip
        const existingPeers = context.state.getPeers();
        if (existingPeers.some(p => p.endpoint === endpoint)) {
            console.log(`[InternalAS] Peer at ${endpoint} already exists. Skipping.`);
            return { success: true, ctx: context };
        }

        console.log(`[InternalAS] Registering peer at ${endpoint}`);

        // We add to state. Since it's stateless HTTP RPC, we don't "connect" here.
        // We just record the intent/config so we can broadcast to it.
        const peerData = {
            id: `peer-${endpoint.replace(/[^a-zA-Z0-9]/g, '-')}`, // Temporary ID or wait for 'open'
            as: 0,
            endpoint: endpoint,
            domains: []
        };

        const { state: newState } = context.state.addPeer(peerData);
        context.state = newState;

        return { success: true, ctx: context };
    }

    private async handleOpenPeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerInfo } = data;

        console.log(`[InternalAS] Handling OPEN request from ${peerInfo.id}`);

        // Idempotency Check: If peer is already known in state, do nothing
        if (context.state.getPeer(peerInfo.id)) {
            console.log(`[InternalAS] Peer ${peerInfo.id} already exists in state. Skipping registration.`);
            return { success: true, ctx: context };
        }

        const authorizedPeer = {
            id: peerInfo.id,
            as: peerInfo.as,
            endpoint: peerInfo.endpoint || 'unknown',
            domains: peerInfo.domains || []
        };

        const { state: newState } = context.state.addPeer(authorizedPeer);
        context.state = newState;

        console.log(`[InternalAS] Peer ${peerInfo.id} registered.`);
        return { success: true, ctx: context };
    }

    private async handleClosePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerId } = data;
        console.log(`[InternalAS] Handling CLOSE request for ${peerId}`);

        const newState = context.state.removePeer(peerId);
        context.state = newState;
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

        const peers = context.state.getPeers();
        console.log(`[InternalAS] Broadcasting ${updateType} to ${peers.length} peers via Batch HTTP RPC.`);

        const { newHttpBatchRpcSession } = await import('capnweb');
        const { getConfig } = await import('../../config.js');
        const config = getConfig();
        const sharedSecret = config.peering.secret;

        const promises = peers.map(async (peer) => {
            if (!peer.endpoint || peer.endpoint === 'unknown') return;

            try {
                // For Batch HTTP RPC, we usually call a bootstrap method to get a scope
                // Consistent with server.ts: connectionFromIBGPPeer(secret)
                const session: any = newHttpBatchRpcSession(peer.endpoint);

                // Pipelined call: get scope and then update
                const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);

                await ibgpScope.update(updateMsg);

                console.log(`[InternalAS] Broadcast to ${peer.id} successful.`);
            } catch (e: any) {
                console.error(`[InternalAS] Failed to update peer ${peer.id} at ${peer.endpoint}:`, e.message);
            }
        });

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
