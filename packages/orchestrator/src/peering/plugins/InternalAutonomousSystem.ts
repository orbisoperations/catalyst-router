
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
        // We need to map PeerInfo + ClientStub to AuthorizedPeer structure logic
        // context.state.addPeer(...) - RouteTable might need updates to store the stub?
        // RouteTable currently stores 'AuthorizedPeer' (interface). 
        // We'll store it as is for now or just log.
        // real implementation requires RouteTable to hold the stub.

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

// BGP Update Message Structure
export const InternalBGPRouteUpdateSchema = z.object({
    resource: z.literal('internalBGPRoute'),
    resourceAction: z.literal('update'),
    data: z.object({
        type: z.union([z.literal('add'), z.literal('remove')]),
        route: z.any().optional(), // ServiceDefinitionSchema
        routeId: z.string().optional()
    })
});

export const InternalPeeringActionsSchema = z.union([
    InternalPeerConfigCreateSchema,
    InternalPeerSessionOpenSchema,
    InternalBGPRouteUpdateSchema
]);
