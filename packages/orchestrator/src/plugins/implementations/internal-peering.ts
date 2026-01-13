import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';
import { Peer } from '../../peering/peer.js';
import { getConfig } from '../../config.js';

export class InternalPeeringPlugin extends BasePlugin {
    name = 'InternalPeeringPlugin';

    constructor(private dispatchAction: (action: any) => Promise<any>) {
        super();
    }

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // 0. Broadcast Local Route Changes (Side-Effect)
        if (action.resource === 'dataChannel' && (action.action === 'create' || action.action === 'update')) {
            // Identify the route.
            // Since plugins run in order, 'state' here might already have the route if a previous plugin added it.
            // OR, if previous plugin returned new state, context.state is updated.
            // InternalRouteTablePlugin and DirectProxyRouteTablePlugin update context.state.
            // So we can look up the route in 'state' by name/protocol or ID.

            // Strategy: Look for the route in the updated state.
            // Logic: If action is create, we broadcast 'add'.
            // We need the full ServiceDefinition to broadcast.
            // We can construct it from action.data, or perform a lookup.

            const { name, fqdn, endpoint, protocol } = action.data;
            const routeId = fqdn || `${name}.internal`;

            // Construct Route object for UpdateMessage
            const route = {
                name,
                fqdn: routeId,
                endpoint: endpoint!,
                protocol: protocol as any
            };

            console.log(`[InternalPeeringPlugin] Broadcasting local route update: ${routeId}`);
            const updateMsg = { type: 'add', route };

            // Broadcast only to established peers
            const peers = state.getPeers();
            for (const p of peers) {
                if (p.isConnected) {
                    p.sendUpdate(updateMsg as any).catch(err => console.warn(`[InternalPeeringPlugin] Failed to broadcast to ${p.id}`, err));
                }
            }
            // Fallthrough to standard processing (we don't modify state here, just side effect)
        }


        // 1. User Control Plane Actions
        if (action.resource === 'internal-peering-user') {
            if (action.action === 'create') {
                const { endpoint, info } = action.data;
                console.log(`[InternalPeeringPlugin] User Request: Create Peer ${endpoint}`);

                // Check for existing peer
                const existingPeer = state.getPeers().find(p => p.address === endpoint);
                if (existingPeer) {
                    if (existingPeer.isConnected) {
                        console.log(`[InternalPeeringPlugin] Peer ${endpoint} already connected.`);
                        return { success: true, ctx: context };
                    }
                    console.log(`[InternalPeeringPlugin] Peer ${endpoint} exists but disconnected.`);
                }

                const config = getConfig();
                const localId = config.peering.localId || 'local-node-id';

                // Create new Peer
                const newPeer = new Peer(endpoint, {
                    id: localId,
                    as: config.peering.as,
                    endpoint: `tcp://${localId}:4015`,
                    domains: config.peering.domains
                },
                    // onDisconnect
                    () => {
                        this.dispatchAction({
                            resource: 'internal-peering-user',
                            action: 'delete',
                            data: { peerId: endpoint }
                        }).catch(err => console.error('[InternalPeeringPlugin] Failed to dispatch disconnect action:', err));
                    },
                    // onRouteUpdate
                    (msg) => {
                        this.dispatchAction({
                            resource: 'internal-peering-protocol',
                            action: 'update',
                            data: { peerId: endpoint, update: msg }
                        }).catch(err => console.error('[InternalPeeringPlugin] Failed to dispatch update action:', err));
                    });

                try {
                    // Start Connection (User Control Plane -> Protocol Start)
                    await newPeer.connect('secret-placeholder');

                    // Add to State
                    const { state: newState } = state.addPeer(newPeer);
                    context.state = newState;

                    return { success: true, ctx: context };

                } catch (e: any) {
                    console.error(`[InternalPeeringPlugin] Failed to connect to ${endpoint}:`, e);
                    return { success: false, error: { message: e.message, pluginName: this.name, error: e } };
                }

            } else if (action.action === 'delete') {
                const { peerId } = action.data;
                // Fixed: removePeer returns RouteTable directly
                const newState = state.removePeer(peerId);
                context.state = newState;
                return { success: true, ctx: context };
            }
        }

        // 2. Protocol Actions (BGP)
        if (action.resource === 'internal-peering-protocol') {
            if (action.action === 'open') {
                const { peerId, info, clientStub } = action.data;
                console.log(`[InternalPeeringPlugin] BGP OPEN from ${peerId}`);

                const config = getConfig();
                const localId = config.peering.localId || 'local-node-id';

                // Create the Peer representation for this incoming connection
                const remoteEndpoint = info.endpoint || `tcp://${peerId}:4000`;

                const peer = new Peer(remoteEndpoint, {
                    id: localId,
                    as: config.peering.as,
                    endpoint: config.peering.endpoint || `tcp://${localId}:4015`,
                    domains: config.peering.domains,
                },
                    // onDisconnect
                    () => {
                        this.dispatchAction({
                            resource: 'internal-peering-user', // Use user-action 'delete' to clean up state
                            action: 'delete',
                            data: { peerId: info.id }
                        }).catch(err => console.error(err));
                    },
                    // onRouteUpdate
                    (msg) => {
                        this.dispatchAction({
                            resource: 'internal-peering-protocol',
                            action: 'update',
                            data: { peerId: info.id, update: msg }
                        }).catch(err => console.error(err));
                    });

                // Initialize the incoming connection
                await peer.accept(info, clientStub);

                // Add to State
                // Fixed: addPeer returns { state, peer }
                const { state: newState } = state.addPeer(peer);
                context.state = newState;

                return { success: true, ctx: context };

            } else if (action.action === 'update') {
                const { peerId, update } = action.data;
                console.log(`[InternalPeeringPlugin] BGP UPDATE from ${peerId}:`, update);

                let newState = state;

                if (update.type === 'add' && update.route) {
                    const res = newState.addExternalRoute(update.route, peerId);
                    newState = res.state;
                } else if (update.type === 'remove' && update.routeId) {
                    // Fixed: removeRoute returns RouteTable directly
                    newState = newState.removeRoute(update.routeId);
                }

                // Broadcast (Split Horizon)
                const peers = newState.getPeers();
                for (const p of peers) {
                    if (p.id !== peerId && p.isConnected) {
                        p.sendUpdate(update).catch(err => console.warn(`Failed to broadcast to ${p.id}`, err));
                    }
                }

                context.state = newState;
                return { success: true, ctx: context };

            } else if (action.action === 'notification') {
                const { peerId, message } = action.data;
                console.log(`[InternalPeeringPlugin] BGP NOTIFICATION from ${peerId}: ${message}`);
                // Fixed: removePeer returns RouteTable directly
                const newState = state.removePeer(peerId);
                context.state = newState;
                return { success: true, ctx: context };
            }
        }

        return { success: true, ctx: context };
    }
}
