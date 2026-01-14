
import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult, PipelineAction } from '../types.js';
import { Peer, OrchestratorDispatcher } from '../../peering/peer.js';
import { getConfig } from '../../config.js';
import { PeerInfo, UpdateMessage } from '../../rpc/schema/peering.js';

// Manager for active peer connections (stubs)
// const activePeers = new Map<string, Peer | any>();

export class InternalPeeringPlugin extends BasePlugin {
    name = 'InternalPeeringPlugin';

    constructor(private dispatch: OrchestratorDispatcher) {
        super();
    }

    /*
    static registerIncomingPeer(id: string, stub: any) {
        activePeers.set(id, {
            id,
            isConnected: true,
            sendUpdate: async (msg: any) => {
                await stub.updateRoute(msg);
            }
        });
    }
    */

    async apply(context: PluginContext): Promise<PluginResult> {
        return { success: true, ctx: context };
        /*
        const { action, state } = context;

        // 1. User Creates Peer (Outgoing Connection)
        if (action.resource === 'internal-peering-user' && action.action === 'create') {
            const { endpoint, secret } = action.data;
            const config = getConfig();

            const localInfo: PeerInfo = {
                id: config.peering.localId || 'unknown', // Need to ensure localId is in config
                as: config.peering.as,
                endpoint: `ws://localhost:${config.port}/rpc`, // Approximation
                domains: config.peering.domains
            };

            const peer = new Peer(endpoint, localInfo, this.dispatch);
            try {
                await peer.connect(secret);

                // Add to state
                const { state: newState } = state.addPeer({
                    id: peer.id,
                    as: 0, // remote AS TBD
                    endpoint: peer.endpoint,
                    domains: [] // remote domains TBD
                });

                activePeers.set(peer.id, peer);

                context.state = newState;
                context.result = { success: true, id: peer.id };
            } catch (e: any) {
                return {
                    success: false,
                    error: { pluginName: this.name, message: `Failed to connect: ${e.message}` }
                };
            }
        }

        // 2. Protocol Actions (Incoming Updates)
        else if (action.resource === 'internal-peering-protocol' && action.action === 'update') {
            const msg = action.data as UpdateMessage;
            const config = getConfig();
            const localId = config.peering.localId || 'unknown';

            // Loop Prevention
            if (msg.path && msg.path.includes(localId)) {
                console.warn(`[InternalPeeringPlugin] Loop detected for route ${msg.routeId}, dropping update. Path: ${msg.path.join(' -> ')}`);
                return { success: true, ctx: context };
            }

            if (msg.type === 'add' && msg.route) {
                // Add to internal routes
                const { state: newState } = state.addInternalRoute(msg.route);
                context.state = newState;

                // Propagate to other peers (BGP Re-advertisement)
                const newPath = msg.path ? [...msg.path, localId] : [localId];
                const propagationMsg: UpdateMessage = {
                    ...msg,
                    path: newPath
                };

                // Broadcast
                activePeers.forEach(peer => {
                    // Optimization could be added here to avoid returning to sender, 
                    // but loop prevention handles correctness.
                    peer.sendUpdate(propagationMsg).catch(console.error);
                });

            } else if (msg.type === 'remove' && msg.routeId) {
                const { state: newState } = state.removeRoute(msg.routeId);
                context.state = newState;
                
                // Propagate removal
                const newPath = msg.path ? [...msg.path, localId] : [localId];
                const propagationMsg: UpdateMessage = {
                    ...msg,
                    path: newPath
                };
                 activePeers.forEach(peer => {
                    peer.sendUpdate(propagationMsg).catch(console.error);
                });
            }
        }

        // 3. Incoming Connection Registration (From PeeringService)
        else if (action.resource as string === 'internal-peering-incoming' && action.action === 'create') {
            const { info, clientStub } = action.data as any;

            // Register stub
            InternalPeeringPlugin.registerIncomingPeer(info.id, clientStub);

            // Add to state
            const { state: newState } = state.addPeer(info);
            context.state = newState;
        }

        // 4. Broadcast Local Changes
        else if (action.resource === 'dataChannel' && (action.action === 'create' || action.action === 'update')) {
            // Broadcast to all active peers
            const route = context.state.getInternalRoutes().find(r =>
                r.service.name === action.data.name && r.service.protocol === action.data.protocol
            );
            
            if (route) { 
                const config = getConfig();
                const localId = config.peering.localId || 'unknown';
                
                // Initial Path: [My ID]
                const msg: UpdateMessage = { 
                    type: 'add', 
                    route: route.service,
                    path: [localId] 
                };
                
                for (const p of activePeers.values()) {
                    p.sendUpdate(msg).catch(console.error);
                }
            }
        }

        return { success: true, ctx: context };
        */
    }
}
