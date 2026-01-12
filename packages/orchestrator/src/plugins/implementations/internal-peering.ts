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
                console.log(`[InternalPeeringPlugin] Adding peer: ${address}`);

                // Check if already exists
                // We'd need to check existing peers, but for now we just create new or overwrite?
                // Peer ID is currently address.

                // Create Peer
                const newPeer = new Peer(address, {
                    id: 'local-node-id', // TODO: Get from config
                    as: 100, // TODO: Get from config
                    endpoint: 'tcp://local-node:4015' // TODO: Get from config
                });

                try {
                    // Connect
                    await newPeer.connect(secret);

                    // Add to State
                    state.addPeer(newPeer);

                    return {
                        success: true,
                        ctx: context // We don't really have a 'result' structure for Peer Create in ActionResultSchema yet except ID
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
