
import {
    PeerPublicApi,
    AuthorizedPeer,
    PeerClient,
    PeerInfo,
    UpdateMessage,
    PeerSessionState
} from '../../src/rpc/schema/peering.js';

// Mock Implementation that wires calls directly to the target service
export class MockRpcConnection {
    constructor(private targetService: PeerPublicApi) { }

    getService<T>(): T {
        // Return the target directly as the service proxy
        return this.targetService as unknown as T;
    }
}

// Helper to create a fully wired Node Environment
import { RouteTable } from '../../src/state/route-table.js';
import { PeeringService } from '../../src/peering/service.js';
import { Peer } from '../../src/peering/peer.js';
import { InternalPeeringPlugin } from '../../src/plugins/implementations/internal-peering.js';
import { Action } from '../../src/rpc/schema/actions.js';

export class TestNode {
    public routeTable: RouteTable;
    public peeringService: PeeringService;
    public id: string;
    public as: number;
    private plugin: InternalPeeringPlugin;

    constructor(id: string, as: number = 100, domains: string[] = []) {
        this.id = id;
        this.as = as;
        this.routeTable = new RouteTable();

        // 1. Setup Plugin
        // The Plugin expects a 'dispatchAction' to send actions BACK to the pipeline.
        // In this TestNode, 'pipeline' is just 'this.apply'.
        this.plugin = new InternalPeeringPlugin(this.apply.bind(this));

        // 2. Setup PeeringService
        // PeeringService expects 'dispatchAction' processing.
        this.peeringService = new PeeringService(this.apply.bind(this), {
            as,
            domains,
            localId: id,
            endpoint: `mock://${id}`
        });
    }

    // Mini-Pipeline to process actions
    async apply(action: Action): Promise<any> {
        // We only support InternalPeeringPlugin here
        const result = await this.plugin.apply({
            action,
            state: this.routeTable,
            authxContext: {} // Mock auth context
        });

        if (result.success) {
            // Update state (Immutable update)
            this.routeTable = result.ctx.state;
            return { success: true };
        } else {
            console.error(`[TestNode ${this.id}] Action failed:`, result.error);
            return { success: false, error: result.error };
        }
    }

    // Connect to another TestNode
    async connectTo(targetNode: TestNode) {
        const localInfo: PeerInfo = {
            id: this.id,
            as: this.as,
            endpoint: `mock://${this.id}`,
            domains: []
        };

        // Create Peer (Outgoing)
        // We manually wire it up because InternalPeeringPlugin 'create' action doesn't support Mock injection.
        // But we want the callbacks to dispatch actions so the Plugin handles the logic (updates, routing).

        const peer = new Peer(targetNode.id, localInfo,
            // onDisconnect
            () => {
                this.apply({
                    resource: 'internal-peering-user',
                    action: 'delete',
                    data: { peerId: targetNode.id }
                });
            },
            // onRouteUpdate
            (msg) => {
                this.apply({
                    resource: 'internal-peering-protocol',
                    action: 'update',
                    data: { peerId: targetNode.id, update: msg }
                });
            }
        );

        // Inject the target's PeeringService as the Public API
        await peer.connect("secret", targetNode.peeringService);

        // Add to State
        // We simulate what the plugin 'create' action does: add peer to state.
        const res = this.routeTable.addPeer(peer);
        this.routeTable = res.state;
    }
}
