import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';
import { Peer } from '../../peering/peer.js';

export class InternalPeeringPlugin extends BasePlugin {
    name = 'InternalPeeringPlugin';

    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        if (action.resource === 'peer') {
            if (action.action === 'create') {
                const { address, secret } = action.data;
                console.log(`[InternalPeeringPlugin] Request to add peer: ${address}`);

                // Check for existing peer
                const existingPeer = state.getPeers().find(p => p.address === address || p.id === address);
                if (existingPeer) {
                    if (existingPeer.isConnected) {
                        console.log(`[InternalPeeringPlugin] Peer ${address} already connected. Reusing connection.`);
                        return { success: true, ctx: context };
                    }
                    console.log(`[InternalPeeringPlugin] Peer ${address} exists but disconnected. Reconnecting...`);
                    // If disconnected, we might want to reconnect using the existing instance or replace it.
                    // For now, let's try to reconnect the existing one if possible, or remove and replace?
                    // Peer class disconnect cleanup might have left it in a state where we should probably just create a new one to be safe,
                    // OR we explicitly support reconnecting.
                    // Given Peer.ts connect() logic, it seems reusable.

                    try {
                        await existingPeer.connect(secret);
                        // State doesn't change if we just reconnect an existing object in the map (mutable internal state of Peer)
                        // But for strict immutability of the Table, the Table hasn't changed structure.
                        return { success: true, ctx: context };
                    } catch (e: any) {
                        console.error(`[InternalPeeringPlugin] Failed to reconnect peer ${address}:`, e);
                        return { success: false, error: { message: e.message, pluginName: this.name, error: e } };
                    }
                }

                // Create New Peer
                const newPeer = new Peer(address, {
                    id: 'local-node-id', // TODO: Get from config
                    as: 100, // TODO: Get from config
                    endpoint: 'tcp://local-node:4015', // TODO: Get from config
                    domains: [] // TODO: Get from config.peering.domains
                }, () => {
                    // On disconnect, update state immutably
                    // NOTE: This callback concept with immutable state is tricky because 'this.state' in the plugin/server needs to be updated.
                    // The server handles state updates via the pipeline result.
                    // But an async disconnect happens OUTSIDE the pipeline execution.
                    // We need a way to dispatch a state update action or have a reference to a proactive state manager.
                    // For now, we'll assume the Service interaction or some other mechanism handles this,
                    // OR we simply acknowledge that this callback might need access to a global store if strictly following this pattern.
                    // START_HACK: Accessing GlobalRouteTable directly for async disconnects until we have an async event bus
                    // import { GlobalRouteTable } from '../../state/route-table.js';
                    // But wait, we passed 'state' into pipeline.
                    // This is a known architectural limitation of the pipeline: it handles synchronous actions.
                    // Asynchronous vents (disconnects) need a different path.
                    // For now, let's keep the callback but maybe just log, as removing from state requires a new transaction.
                    console.log(`[InternalPeeringPlugin] Peer ${address} disconnected.`);
                });

                try {
                    // Connect
                    await newPeer.connect(secret);

                    // Add to State
                    const { state: newState } = state.addPeer(newPeer);
                    context.state = newState;

                    return {
                        success: true,
                        ctx: context
                    };
                } catch (e: any) {
                    console.error(`[InternalPeeringPlugin] Failed to connect to ${address}:`, e);
                    return {
                        success: false,
                        error: {
                            message: e.message,
                            pluginName: this.name,
                            error: e
                        }
                    };
                }
            }
        }
        return { success: true, ctx: context };
    }
}
