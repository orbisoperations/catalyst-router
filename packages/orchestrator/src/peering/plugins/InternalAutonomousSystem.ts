
import { BasePlugin } from '../../plugins/base.js';
import { PluginContext, PluginResult } from '../../plugins/types.js';
import { z } from 'zod';

export class InternalAutonomousSystemPlugin extends BasePlugin {
    name = 'InternalAutonomousSystemPlugin';

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

        if (action.resource === 'internalBGPRoute' && action.resourceAction === 'update') {
            return this.handleRouteUpdate(context);
        }

        return { success: true, ctx: context };
    }

    private async handleCreatePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { endpoint, secret } = data; // { endpoint: string, secret: string }

        console.log(`[InternalAS] Initiating connection to ${endpoint}`);

        try {
            // Dynamic import capnweb to avoid top-level issues if any
            const { newWebSocketRpcSession } = await import('capnweb');

            // 1. Connect and Authorize
            // Note: endpoint should be the IBGP endpoint (e.g. ws://host:port/ibgp)
            // The user will provide the full URL.
            const remoteServer = newWebSocketRpcSession(endpoint);

            // @ts-ignore - loose typing for RPC
            const authorizedPeer = await remoteServer.authorize(secret);

            // 2. Open Session
            const localInfo = {
                id: process.env.CATALYST_NODE_ID || 'unknown-node', // detailed logic to get ID later
                as: parseInt(process.env.CATALYST_AS || '0')
            };

            // Stub for local callbacks (PeerClient)
            // We need to pass a stub that implements keepAlive, updateRoute etc.
            // For OPEN phase, it might just need to exist.
            const localStub = {
                keepAlive: async () => { console.log('[InternalAS] Received KeepAlive'); },
                updateRoute: async (msg: any) => { console.log('[InternalAS] Received Update', msg); }
            };

            const sessionState = await authorizedPeer.open(localInfo, localStub);

            console.log(`[InternalAS] Peer Connected! Accepted: ${sessionState.accepted}`);

            // TODO: Store peer in state (context.state.addPeer...)

            // Dispatch/Process inbound 'open' logic locally? 
            // The remote side dispatches 'open:internal-as'. 
            // We (initiator) just received confirmation.
            // We should register the peer in our local table.
            // For now, just logging success.

        } catch (error: any) {
            console.error(`[InternalAS] Connection failed:`, error);
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

        // Register peer in RouteTable
        // We create a mocked/stubbed AuthorizedPeer object for the state
        // In a real scenario, this object would have methods to call back the peer (using clientStub)
        const authorizedPeer = {
            id: peerInfo.id,
            as: peerInfo.as,
            endpoint: peerInfo.endpoint || 'unknown',
            domains: peerInfo.domains || [],
            // Methods and stub are not part of the AuthorizedPeer schema used by RouteTable
            // We would need a separate PeerManager to hold the active connection stubs.
        };

        const { state: newState } = context.state.addPeer(authorizedPeer);
        context.state = newState;

        console.log(`[InternalAS] Peer ${peerInfo.id} registered.`);

        return { success: true, ctx: context };
    }

    private async handleClosePeer(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { peerId } = data; // { peerId: string }

        console.log(`[InternalAS] Handling CLOSE request for ${peerId}`);

        // Remove peer and its routes
        const newState = context.state.removePeer(peerId);
        context.state = newState;

        console.log(`[InternalAS] Peer ${peerId} and its routes removed.`);

        return { success: true, ctx: context };
    }

    private async handleRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { data } = context.action;
        const { type, route, routeId } = data;

        console.log(`[InternalAS] Handling BGP UPDATE: ${type} ${route?.name || routeId}`);

        // We assume the route comes from an authorized peer (verified by caller/RPC layer)
        // Ideally the action data should contain 'sourcePeerId' injected by the dispatcher?
        // OR we trust the content. For now, let's assume we need to know WHO sent it.
        // The current schema doesn't carry 'sourcePeerId' in the data payload explicitly for the user,
        // but the RPC handler (AuthorizedPeer) should normally inject it.
        // Let's assume for this mock that we can pass it or it's not strictly enforced yet 
        // (but then removeRoutesFromPeer won't work if we don't set it!)

        // HACK: We need sourcePeerId. let's check if we can add it to the schema or if it's there.
        // The schema 'InternalBGPRouteUpdateSchema' does NOT have it.
        // We probably need to add 'sourcePeerId' to the action data payload in the schema.

        // For now, let's assume the 'AuthorizedPeer' which dispatches this ADDS the peerID.
        // So allow 'sourcePeerId' in data (even if untyped or loose for now).
        // Actually, let's just add it to the schema to be safe.

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
    InternalBGPRouteUpdateSchema
]);
