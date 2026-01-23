
import { BasePlugin } from '../../plugins/base.js';
import type { PluginContext, PluginResult } from '../../plugins/types.js';
import type { ApplyActionResult } from '../../rpc/schema/index.js';
import { getConfig } from '../../config.js';
import { getHttpPeerSession } from '../../rpc/client.js';
import type {
    PeerInfo,
    AuthorizedPeer
} from '../../rpc/schema/peering.js';
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
    type UpdateMessage,
    type IBGPOpenResult
} from '../../rpc/schema/peering.js';
import { LocalRoutingCreateActionSchema, LocalRoutingDeleteActionSchema, LocalRoutingUpdateActionSchema } from './local-routing.js';

export class InternalBGPPlugin extends BasePlugin {
    name = 'InternalBGPPlugin';

    constructor(private readonly sessionFactory: typeof getHttpPeerSession = getHttpPeerSession) {
        super();
    }

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action } = context;

        switch (action.resource) {
            case IBGPConfigResource.value:
                switch (action.resourceAction) {
                    case IBGPConfigResourceAction.enum.create:
                        return this.handleConfigCreatePeer(context);
                    case IBGPConfigResourceAction.enum.delete:
                        return this.handleConfigDeletePeer(context);
                    case IBGPConfigResourceAction.enum.update:
                        return this.handleConfigUpdatePeer(context);
                }
                break;

            case IBGPProtocolResource.value:
                switch (action.resourceAction) {
                    case IBGPProtocolResourceAction.enum.open:
                        return this.handleProtocolOpen(context);
                    case IBGPProtocolResourceAction.enum.close:
                        return this.handleProtocolClose(context);
                    case IBGPProtocolResourceAction.enum.update:
                        return this.handleProtocolUpdate(context);
                    case IBGPProtocolResourceAction.enum.keepAlive:
                        return this.handleProtocolKeepAlive(context);
                }
                break;

            case 'localRoute':
                if (action.resourceAction === 'create' || action.resourceAction === 'delete' || action.resourceAction === 'update') {
                    return this.broadcastRouteUpdate(context);
                }
                break;
        }

        return { success: true, ctx: context };
    }

    private getMyPeerInfo(): PeerInfo {
        const config = getConfig();
        return {
            id: config.ibgp.localId || 'unknown',
            as: config.as,
            domains: config.ibgp.domains,
            endpoint: config.ibgp.endpoint || 'unknown'
        };
    }

    private async handleConfigCreatePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigCreatePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            ctx: context,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP create peer action',
                error: result.error
            }
        };

        const { endpoint, domains: _domains } = result.data.data;

        const existingPeers = context.state.getPeers();
        if (existingPeers.some(p => p.endpoint === endpoint)) {
            console.log(`[InternalAS] Peer at ${endpoint} already exists. Skipping.`);
            return { success: true, ctx: context };
        }

        console.log(`[InternalAS] Handshaking with peer at ${endpoint}...`);

        const config = getConfig();

        // Handshake before adding to state
        try {
            const ibgpScope = this.sessionFactory(endpoint, config.ibgp.secret);
            const myPeerInfo = this.getMyPeerInfo();

            // 1. OPEN (Pipelined)
            const openPromise = ibgpScope.open(myPeerInfo);

            // 2. UPDATE (Initial Sync - Pipelined)
            const routes = context.state.getAllRoutes();
            let updatePromise: Promise<ApplyActionResult> | Promise<void> = Promise.resolve();

            if (routes.length > 0) {
                const updates = routes.map(route => ({
                    type: 'add' as const,
                    route: route.service,
                    asPath: [config.as, ...(route.asPath || [])]
                }));
                // Use the returned peerInfo from the open promise?
                // Actually, for pipelining, we just pass myPeerInfo again or wait?
                // CapnProto/CapnWeb pipelining works on PROMISES.
                // But `update` takes `PeerInfo`, not a promise.
                // We should just fire both.
                updatePromise = ibgpScope.update(myPeerInfo, updates as UpdateMessage[]);
            }

            // Execute batch
            const [openResult] = await Promise.all([openPromise, updatePromise]);
            const openRes = openResult as IBGPOpenResult;

            if (!openResult.success) {
                throw new Error(openResult.error || 'Peer rejected OPEN request');
            }

            // Use the returned PeerInfo for registration
            const peerData = openResult.peerInfo;

            const { state: newState } = context.state.addPeer(peerData);
            context.state = newState;
            console.log(`[InternalAS] Peer ${peerData.id} successfully added to state after handshake.`);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[InternalAS] Failed handshake with ${endpoint}:`, message);
            return {
                success: false,
                ctx: context,
                error: { pluginName: this.name, message: `Failed to handshake with peer: ${message}` }
            };
        }

        return { success: true, ctx: context };
    }

    private async handleConfigUpdatePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigUpdatePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            ctx: context,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP update peer action',
                error: result.error
            }
        };

        const { peerId, endpoint, domains } = result.data.data;
        const peer = context.state.getPeer(peerId);
        if (!peer) {
            return {
                success: false,
                ctx: context,
                error: { pluginName: this.name, message: `Peer ${peerId} not found for update` }
            };
        }

        console.log(`[InternalAS] Updating peer ${peerId} to ${endpoint}`);

        const config = getConfig();
        const myPeerInfo = this.getMyPeerInfo();

        try {
            // 1. Close Old Connection
            if (peer.endpoint && peer.endpoint !== 'unknown') {
                try {
                    const oldScope = this.sessionFactory(peer.endpoint, config.ibgp.secret);
                    await oldScope.close(myPeerInfo);
                } catch {
                    // Ignore errors during close of old connection
                }
            }

            // 2. Open New Connection
            // 2. Open New Connection & Pipeline
            const ibgpScope = this.sessionFactory(endpoint, config.ibgp.secret);

            const openPromise = ibgpScope.open(myPeerInfo);
            let updatePromise: Promise<ApplyActionResult> | Promise<void> = Promise.resolve();

            // 3. Update (Sync)
            const routes = context.state.getAllRoutes();
            if (routes.length > 0) {
                const updates = routes.map(route => ({
                    type: 'add' as const,
                    route: route.service,
                    asPath: [config.as, ...(route.asPath || [])]
                }));
                updatePromise = ibgpScope.update(myPeerInfo, updates as UpdateMessage[]);
            }

            const [openResult] = await Promise.all([openPromise, updatePromise]);

            if (!openResult.success) {
                throw new Error(openResult.error || 'Peer rejected OPEN request');
            }

            // 4. Update State
            const updatedPeer = {
                ...peer,
                endpoint,
                domains: domains !== undefined ? domains : peer.domains
            };

            const { state: newState } = context.state.addPeer(updatedPeer);
            context.state = newState;

        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[InternalAS] Failed handshake updates with ${endpoint}:`, message);
            return {
                success: false,
                ctx: context,
                error: { pluginName: this.name, message: `Failed to handshake with new endpoint: ${message}` }
            };
        }

        return { success: true, ctx: context };
    }

    private async handleConfigDeletePeer(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPConfigDeletePeerSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            ctx: context,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP delete peer action',
                error: result.error
            }
        };

        const { peerId } = result.data.data;
        const peer = context.state.getPeer(peerId);

        if (peer) {
            console.log(`[InternalAS] Deleting peer ${peerId}`);
            const config = getConfig();
            const myPeerInfo = this.getMyPeerInfo();

            // 1. Close Connection
            if (peer.endpoint && peer.endpoint !== 'unknown') {
                try {
                    const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret);
                    await ibgpScope.close(myPeerInfo);
                } catch {
                    // Ignore errors during close
                }
            }

            // 2. Update State
            const newState = context.state.removePeer(peerId);
            context.state = newState;
        }

        return { success: true, ctx: context };
    }

    // --- iBGP Protocol Actions ---
    private async handleProtocolOpen(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolOpenSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            ctx: context,
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
        setImmediate(async () => {
            try {
                const config = getConfig();
                const myPeerInfo = this.getMyPeerInfo();
                const ibgpScope = this.sessionFactory(peerInfo.endpoint, config.ibgp.secret);

                // Reverse sync: Open -> Update
                const openResult = await ibgpScope.open(myPeerInfo) as IBGPOpenResult;
                if (!openResult.success) {
                    console.warn(`[InternalAS] Reverse OPEN failed to ${peerInfo.id}: ${openResult.error}`);
                    return;
                }

                const routes = context.state.getAllRoutes();
                if (routes.length > 0) {
                    const updates = routes.map(route => ({
                        type: 'add' as const,
                        route: route.service,
                        asPath: [config.as, ...(route.asPath || [])]
                    }));
                    await ibgpScope.update(myPeerInfo, updates as UpdateMessage[]);
                }
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                console.error(`[InternalAS] Background sync failed for ${peerInfo.id}:`, message);
            }
        });

        return { success: true, ctx: context };
    }

    private async handleProtocolClose(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolCloseSchema.safeParse(action);
        if (!result.success) {
            return {
                success: false,
                ctx: context,
                error: {
                    pluginName: this.name,
                    message: 'Error parsing message for iBGP close protocol action',
                    error: result.error
                }
            };
        }

        const { peerInfo } = result.data.data;
        console.log(`[InternalAS] Handling CLOSE request for ${peerInfo.id}`);

        const newState = context.state.removePeer(peerInfo.id);
        context.state = newState;
        return { success: true, ctx: context };
    }

    private async handleProtocolKeepAlive(context: PluginContext): Promise<PluginResult> {
        const { action } = context;
        const result = IBGPProtocolKeepAliveSchema.safeParse(action);
        if (!result.success) return {
            success: false,
            ctx: context,
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
            ctx: context,
            error: {
                pluginName: this.name,
                message: 'Error parsing message for iBGP update protocol action',
                error: result.error
            }
        };

        const { peerInfo, updateMessages } = result.data.data;
        const sourcePeerId = peerInfo.id;
        const myAs = getConfig().as;

        console.log(`[InternalAS] Handling BGP UPDATE session from ${sourcePeerId} with ${updateMessages.length} messages`);

        let newState = context.state;
        const routesToPropagate: { route: unknown, asPath: number[] }[] = [];

        for (const msg of updateMessages) {
            if (msg.type === 'add') {
                const asPath = msg.asPath || [];

                // Loop Prevention
                if (asPath.includes(myAs)) {
                    console.warn(`[InternalAS] Loop detected for route ${(msg.route as { name: string }).name} (Path: ${asPath}). Dropping.`);
                    continue;
                }

                const res = newState.addInternalRoute(msg.route, sourcePeerId, asPath);
                newState = res.state;

                // Queue for propagation
                routesToPropagate.push({ route: msg.route, asPath });

            } else if (msg.type === 'remove') {
                newState = newState.removeRoute(msg.routeId);
                // TODO: Propagate remove?
            }
        }

        console.log(`[InternalAS] Route table updated. Total routes: ${newState.getRoutes().length}`);
        context.state = newState;

        // Propagate learned routes to OTHER peers
        if (routesToPropagate.length > 0) {
            const peers = newState.getPeers().filter(p => p.id !== sourcePeerId);
            console.log(`[InternalAS] Propagating ${routesToPropagate.length} routes to ${peers.length} peers.`);

            const propagationPromises: Promise<ApplyActionResult>[] = [];
            for (const peer of peers) {
                for (const item of routesToPropagate) {
                    // Prepend My AS before sending
                    const newPath = [myAs, ...item.asPath];
                    propagationPromises.push(this.sendIndividualUpdate(context, peer.id, {
                        type: 'add',
                        route: item.route,
                        asPath: newPath
                    } as UpdateMessage));
                }
            }

            const results = await Promise.all(propagationPromises);
            const firstFailure = results.find((r: ApplyActionResult) => !r.success);
            if (firstFailure) {
                return {
                    success: false,
                    ctx: context,
                    error: {
                        pluginName: this.name,
                        message: `Propagation failed: ${firstFailure.error}`
                    }
                };
            }
        }

        return { success: true, ctx: context };
    }

    private async executeHandshakeAndSync(context: PluginContext, peer: AuthorizedPeer): Promise<void> {
        const routes = context.state.getAllRoutes();
        const config = getConfig();
        const myPeerInfo: PeerInfo = {
            id: config.ibgp.localId || 'unknown',
            as: config.as,
            domains: config.ibgp.domains,
            endpoint: config.ibgp.endpoint || 'unknown'
        };

        const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret);

        // Sequential: OPEN then UPDATE
        const result = await ibgpScope.open(myPeerInfo) as IBGPOpenResult;

        if (!result.success) {
            throw new Error(result.error || 'Peer rejected OPEN request');
        }

        if (routes.length > 0) {
            const updates = routes.map(route => ({
                type: 'add' as const,
                route: route.service,
                // If it's a local route, [myAs]. If learned, [myAs, ...originalPath]
                // But wait, the route in state ALREADY has the original path if learned.
                // We just need to prepend MyAS to whatever is in state.
                asPath: [config.as, ...(route.asPath || [])]
            }));

            await ibgpScope.update(myPeerInfo, updates);
        }
    }

    private async syncExistingRoutesToPeer(context: PluginContext, peerId: string): Promise<void> {
        const start = Date.now();
        const peer = context.state.getPeer(peerId);
        if (!peer || !peer.endpoint || peer.endpoint === 'unknown') return;

        console.log(`[InternalAS] syncExistingRoutesToPeer: Peer=${peerId}, RouteCount=${context.state.getAllRoutes().length}`);

        try {
            await this.executeHandshakeAndSync(context, peer);
            console.log(`[InternalAS] Sync to ${peerId} completed in ${Date.now() - start}ms.`);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[InternalAS] Failed to sync to peer ${peerId} at ${peer?.endpoint}:`, message);
        }
    }

    private async sendIndividualUpdate(context: PluginContext, peerId: string, updateMsg: UpdateMessage): Promise<ApplyActionResult> {
        const peer = context.state.getPeer(peerId);
        if (!peer || !peer.endpoint || peer.endpoint === 'unknown') return { success: true, results: [] };

        try {
            const config = getConfig();
            const ibgpScope = this.sessionFactory(peer.endpoint, config.ibgp.secret);
            const myPeerInfo = this.getMyPeerInfo();

            return await ibgpScope.update(myPeerInfo, [updateMsg]);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[InternalAS] Failed to send update to peer ${peerId} at ${peer.endpoint}:`, message);
            return { success: false, results: [], error: message };
        }
    }

    private async broadcastRouteUpdate(context: PluginContext): Promise<PluginResult> {
        const { action } = context;

        let updateType: 'add' | 'remove';
        let routeData: { name: string;[key: string]: unknown } | undefined;
        let routeId: string | undefined;

        if (action.resourceAction === 'create') {
            const result = LocalRoutingCreateActionSchema.safeParse(action);
            if (!result.success) {
                console.error(`[InternalAS] Failed to parse localRoute create action:`, result.error.message);
                return { success: true, ctx: context }; // Still return success to allow OTHER plugins to run, but log the error
            }
            updateType = 'add';
            routeData = result.data.data;
        } else if (action.resourceAction === 'update') {
            const result = LocalRoutingUpdateActionSchema.safeParse(action);
            if (!result.success) {
                console.error(`[InternalAS] Failed to parse localRoute update action:`, result.error.message);
                return { success: true, ctx: context };
            }
            // BGP Treat update as 'add' (upsert)
            updateType = 'add';
            routeData = result.data.data;
        } else {
            const result = LocalRoutingDeleteActionSchema.safeParse(action);
            if (!result.success) {
                console.error(`[InternalAS] Failed to parse localRoute delete action:`, result.error.message);
                return { success: true, ctx: context };
            }
            updateType = 'remove';
            routeId = result.data.data.id;
        }

        const updateMsg: UpdateMessage = (updateType === 'add')
            ? { type: 'add', route: routeData as { name: string;[key: string]: unknown }, asPath: [getConfig().as] }
            : { type: 'remove', routeId: routeId! };

        const peers = context.state.getPeers();
        console.log(`[InternalAS] Broadcasting ${updateType} to ${peers.length} peers via WebSocket RPC.`);

        const promises = peers.map((peer) => this.sendIndividualUpdate(context, peer.id, updateMsg));

        const results = await Promise.all(promises);
        const firstFailure = results.find((r: ApplyActionResult) => !r.success);

        if (firstFailure) {
            return {
                success: false,
                ctx: context,
                error: {
                    pluginName: this.name,
                    message: `Broadcast failed: ${firstFailure.error}`
                }
            };
        }

        return { success: true, ctx: context };
    }
}
