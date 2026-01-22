
import { BasePlugin } from '../../plugins/base.js';
import { PluginContext, PluginResult } from '../../plugins/types.js';
import { newHttpBatchRpcSession } from 'capnweb';
import { getConfig } from '../../config.js';
import {
    IBGPConfigCreatePeerSchema,
    IBGPConfigUpdatePeerSchema,
    IBGPConfigDeletePeerSchema,
    IBGPProtocolOpenSchema,
    IBGPProtocolCloseSchema,
    IBGPProtocolUpdateSchema,
    IBGPProtocolKeepAliveSchema,
    IBGPConfigResource,
    IBGPConfigResourceAction,
    IBGPProtocolResource,
    IBGPProtocolResourceAction,
    PeerInfo
} from '../../rpc/schema/peering.js';
import { LocalRoutingCreateActionSchema, LocalRoutingDeleteActionSchema } from './local-routing.js';

export class InternalBGPPlugin extends BasePlugin {
    name = 'InternalBGPPlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action } = context;

        switch (action.resource) {
            case IBGPConfigResource.value:
                switch (action.resourceAction) {
                    case IBGPConfigResourceAction.enum.create:
                        return this.handleCreatePeer(context);
                    case IBGPConfigResourceAction.enum.delete:
                        return this.handleDeletePeer(context);
                    case IBGPConfigResourceAction.enum.update:
                        return this.handleUpdatePeer(context);
                }
                break;

            case IBGPProtocolResource.value:
                switch (action.resourceAction) {
                    case IBGPProtocolResourceAction.enum.open:
                        return this.handleOpenPeer(context);
                    case IBGPProtocolResourceAction.enum.close:
                        return this.handleClosePeer(context);
                    case IBGPProtocolResourceAction.enum.update:
                        return this.handleProtocolUpdate(context);
                    case IBGPProtocolResourceAction.enum.keepAlive:
                        return this.handleKeepAlive(context);
                }
                break;

            case 'localRoute':
                if (action.resourceAction === 'create' || action.resourceAction === 'delete') {
                    return this.broadcastRouteUpdate(context);
                }
                break;
        }

        return { success: true, ctx: context };
    }

    private async handleCreatePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigCreatePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP create peer action',
                error: result.error
            }
        };

        const { endpoint } = result.data.data;

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

    private async handleUpdatePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigUpdatePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP update peer action',
                error: result.error
            }
        };

        const { peerId, endpoint } = result.data.data;
        const peer = context.state.getPeer(peerId);
        if (!peer) {
            return {
                success: false,
                error: { pluginName: this.name, message: `Peer ${peerId} not found for update` }
            };
        }

        console.log(`[InternalAS] Updating peer ${peerId} to ${endpoint}`);

        const updatedPeer = {
            ...peer,
            endpoint
        };

        const { state: newState } = context.state.addPeer(updatedPeer); // addPeer handles overwrite
        context.state = newState;

        return { success: true, ctx: context };
    }

    private async handleDeletePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigDeletePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP delete peer action',
                error: result.error
            }
        };

        const { peerId } = result.data.data;
        console.log(`[InternalAS] Deleting peer ${peerId}`);

        const newState = context.state.removePeer(peerId);
        context.state = newState;

        return { success: true, ctx: context };
    }

    private async handleOpenPeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolOpenSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP open protocol action',
                error: result.error
            }
        };

        const { peerInfo } = result.data.data;

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

    private async handleClosePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolCloseSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP close protocol action',
                error: result.error
            }
        };

        const { peerInfo } = result.data.data;
        console.log(`[InternalAS] Handling CLOSE request for ${peerInfo.id}`);

        const newState = context.state.removePeer(peerInfo.id);
        context.state = newState;
        return { success: true, ctx: context };
    }

    private async handleKeepAlive(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolKeepAliveSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP keepalive protocol action',
                error: result.error
            }
        };

        // For now, keepalive just updates the last seen time in orchestration state if we had one
        // but we don't currently track "lastSeen" in the AuthorizedPeer record.
        return { success: true, ctx: context };
    }

    private async handleProtocolUpdate(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolUpdateSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP update protocol action',
                error: result.error
            }
        };

        const { peerInfo, updateMessages } = result.data.data;
        const sourcePeerId = peerInfo.id;

        console.log(`[InternalAS] Handling BGP UPDATE session from ${sourcePeerId} with ${updateMessages.length} messages`);

        let newState = context.state;
        for (const msg of updateMessages) {
            if (msg.type === 'add') {
                const res = newState.addInternalRoute(msg.route, sourcePeerId);
                newState = res.state;
            } else if (msg.type === 'remove') {
                newState = newState.removeRoute(msg.routeId);
            }
        }

        console.log(`[InternalAS] Route table updated. Total routes: ${newState.getRoutes().length}`);

        context.state = newState;
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
            const myPeerInfo: PeerInfo = {
                id: config.peering.localId || 'unknown',
                as: config.peering.as,
                domains: config.peering.domains,
                services: [],
                endpoint: config.peering.endpoint || 'unknown'
            };

            const session: any = newHttpBatchRpcSession(peer.endpoint);
            const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);

            // Always start with OPEN to ensure bidirectional handshake
            const openPromise = ibgpScope.open(myPeerInfo);

            if (routes.length > 0) {
                const updates = routes.map(route => ({
                    type: 'add' as const,
                    route: route.service
                }));

                await ibgpScope.update(myPeerInfo, updates);
                await openPromise;
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
            const myPeerInfo: PeerInfo = {
                id: config.peering.localId || 'unknown',
                as: config.peering.as,
                domains: config.peering.domains,
                services: [],
                endpoint: config.peering.endpoint || 'unknown'
            };

            const session: any = newHttpBatchRpcSession(peer.endpoint);
            const ibgpScope = session.connectionFromIBGPPeer(sharedSecret);
            // Batch open and update together
            ibgpScope.open(myPeerInfo);
            await ibgpScope.update(myPeerInfo, [updateMsg]);
        } catch (e: any) {
            console.error(`[InternalAS] Failed to send update to peer ${peerId} at ${peer.endpoint}:`, e.message);
        }
    }

    private async broadcastRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { action } = context;

        let updateType: 'add' | 'remove';
        let routeData: any;
        let routeId: string | undefined;

        if (action.resourceAction === 'create') {
            const result = LocalRoutingCreateActionSchema.safeParse(action);
            if (!result.success) return { success: true, ctx: context };
            updateType = 'add';
            routeData = result.data.data;
        } else {
            const result = LocalRoutingDeleteActionSchema.safeParse(action);
            if (!result.success) return { success: true, ctx: context };
            updateType = 'remove';
            routeId = result.data.data.id;
        }

        let updateMsg: any = {
            type: updateType
        };

        if (updateType === 'add') {
            updateMsg.route = routeData;
        } else {
            updateMsg.routeId = routeId;
        }

        const peers = context.state.getPeers();
        console.log(`[InternalAS] Broadcasting ${updateType} to ${peers.length} peers via Batch HTTP RPC.`);

        const promises = peers.map((peer) => this.sendIndividualUpdate(context, peer.id, updateMsg));

        await Promise.all(promises);
        return { success: true, ctx: context };
    }
}
