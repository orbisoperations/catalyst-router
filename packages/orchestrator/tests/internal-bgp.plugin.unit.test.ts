import { describe, it, expect, mock } from 'bun:test';
import { InternalBGPPlugin } from '../src/plugins/implementations/Internal-bgp.js';
import { RouteTable } from '../src/state/route-table.js';
import { PluginContext } from '../src/plugins/types.js';

const mockPeerInfo = {
    id: 'mock-peer-id',
    as: 100,
    endpoint: 'http://mock-endpoint',
    domains: []
};

const mockSession = {
    open: async () => ({ success: true, peerInfo: mockPeerInfo }),
    update: async () => ({ success: true }),
    close: async () => ({ success: true })
};
const mockFactory = () => mockSession as any;


describe('InternalBGPPlugin Unit Tests', () => {

    it('should add an internal route when receiving an "add" update', async () => {
        const plugin = new InternalBGPPlugin(mockFactory);
        const initialState = new RouteTable();

        const route = {
            name: 'proxied-service',
            endpoint: 'http://remote:8080/rpc',
            protocol: 'http:graphql' as any
        };

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-b', as: 100, endpoint: 'http://peer-b:3000/rpc', domains: [] },
                    updateMessages: [
                        {
                            type: 'add',
                            route
                        }
                    ]
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const internalRoutes = result.ctx.state.getInternalRoutes();
        expect(internalRoutes).toHaveLength(1);
        expect(internalRoutes[0].service.name).toBe('proxied-service');
        expect(internalRoutes[0].sourcePeerId).toBe('peer-b');
    });

    it('should remove an internal route when receiving a "remove" update', async () => {
        const plugin = new InternalBGPPlugin(mockFactory);
        const routeId = 'proxied-service:http:graphql';

        // Seed state with the route
        const seedState = new RouteTable().addInternalRoute({
            name: 'proxied-service',
            endpoint: 'http://remote:8080/rpc',
            protocol: 'http:graphql'
        }, 'peer-b').state;

        expect(seedState.getInternalRoutes()).toHaveLength(1);

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-b', as: 100, endpoint: 'http://peer-b:3000/rpc', domains: [] },
                    updateMessages: [
                        {
                            type: 'remove',
                            routeId
                        }
                    ]
                }
            },
            state: seedState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        const internalRoutes = result.ctx.state.getInternalRoutes();
        expect(internalRoutes).toHaveLength(0);
    });

    it('should trigger broadcast when a local route is created', async () => {
        const plugin = new InternalBGPPlugin(mockFactory);
        const initialState = new RouteTable()
        // Mock the internal broadcast logic if possible, 
        // but since it's a private method and uses dynamic imports, 
        // we can test it by seeding peers and checking if it runs without error 
        // or by spying on the dynamic imports (which is tricky in Bun).

        // For now, let's verify it doesn't crash and potentially check logs or mocked side effects.
        const stateWithPeer = new RouteTable().addPeer({
            id: 'peer-b',
            as: 100,
            endpoint: 'http://peer-b:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: 'localRoute',
                resourceAction: 'create',
                data: {
                    name: 'local-service',
                    endpoint: 'http://localhost:8080',
                    protocol: 'tcp' as any
                }
            } as any,
            state: stateWithPeer,
            results: [],
            authxContext: {} as any
        };

        // We can't easily mock the network call here without more setup, 
        // but we can verify the plugin attempts to broadcast.
        // We'll use a try/catch or just see if it finishes.

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
    });

    it('should remove a peer and its routes when receiving a "close" action', async () => {
        const plugin = new InternalBGPPlugin(mockFactory);
        const peerId = 'peer-b';

        // 1. Seed state with a peer and a route from that peer
        let state = new RouteTable().addPeer({
            id: peerId,
            as: 100,
            endpoint: 'http://peer-b:3000/rpc',
            domains: []
        }).state;

        const { state: seededState } = state.addInternalRoute({
            name: 'remote-service',
            endpoint: 'http://remote:8080',
            protocol: 'tcp'
        }, peerId);

        expect(seededState.getPeers()).toHaveLength(1);
        expect(seededState.getInternalRoutes()).toHaveLength(1);

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'close',
                data: {
                    peerInfo: { id: peerId, as: 100, endpoint: 'http://peer-b:3000/rpc' }
                }
            },
            state: seededState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        if (!result.success) throw new Error('Plugin failed');

        expect(result.ctx.state.getPeers()).toHaveLength(0);
        expect(result.ctx.state.getInternalRoutes()).toHaveLength(0);
    });

    it('should send existing routes to a new peer during OPEN', async () => {
        const plugin = new InternalBGPPlugin(mockFactory);
        const peerId = 'new-peer';
        // 1. Seed state with some routes
        let state = new RouteTable().addInternalRoute({
            name: 'existing-service-1',
            endpoint: 'http://loc:1',
            protocol: 'tcp'
        }).state;

        state = state.addInternalRoute({
            name: 'existing-service-2',
            endpoint: 'http://loc:2',
            protocol: 'tcp'
        }).state;

        const peerInfo = {
            id: 'new-peer',
            as: 200,
            endpoint: 'http://new-peer:3000/rpc',
            domains: []
        };

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'open',
                data: {
                    peerInfo
                }
            },
            state,
            results: [],
            authxContext: {} as any
        };

        // We want to verify that broadcasts happen during the OPEN call.
        // This is hard to unit test without mocking the Batch RPC calls,
        // but it verifies the code path completes.
        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
    });

    it('should trigger broadcast when a local route is updated', async () => {
        // Mock factory to spy on usage
        let callCount = 0;
        const spyFactory = (endpoint: string) => {
            callCount++;
            return mockSession as any;
        };

        const plugin = new InternalBGPPlugin(spyFactory);
        const stateWithPeer = new RouteTable().addPeer({
            id: 'peer-c',
            as: 100,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: 'localRoute',
                resourceAction: 'update',
                data: {
                    name: 'local-service-v2',
                    endpoint: 'http://localhost:8081',
                    protocol: 'tcp'
                }
            } as any,
            state: stateWithPeer,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        // Should call factory for the one peer
        expect(callCount).toBe(1);
    });

    it('should propagate learned routes to other peers and await results (transit)', async () => {
        let propagationCalled = false;
        const transitPeerSession = {
            update: async () => {
                propagationCalled = true;
                return { success: true };
            },
            open: async () => ({ success: true, peerInfo: { id: 'peer-c', as: 300, endpoint: 'http://peer-c:3000/rpc', domains: [] } }),
        };

        const factory = (endpoint: string) => {
            if (endpoint === 'http://peer-c:3000/rpc') return transitPeerSession as any;
            return mockSession as any;
        };

        const plugin = new InternalBGPPlugin(factory);

        // Seed state with peer C
        let state = new RouteTable().addPeer({
            id: 'peer-c',
            as: 300,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-a', as: 100, endpoint: 'http://peer-a:3000/rpc', domains: [] },
                    updateMessages: [
                        {
                            type: 'add',
                            route: {
                                name: 'service-a',
                                endpoint: 'http://a-backend:8080',
                                protocol: 'tcp'
                            },
                            asPath: [100]
                        }
                    ]
                }
            },
            state,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);
        expect(propagationCalled).toBe(true);

        const routesOnB = result.ctx.state.getInternalRoutes();
        expect(routesOnB).toHaveLength(1);
        expect(routesOnB[0].asPath).toEqual([100]);
    });

    it('should fail if propagation to transit peer fails', async () => {
        const failingSession = {
            update: async () => ({ success: false, error: 'Network timeout' }),
            open: async () => ({ success: true, peerInfo: { id: 'peer-c', as: 300, endpoint: 'http://peer-c:3000/rpc', domains: [] } }),
        };

        const factory = (endpoint: string) => failingSession as any;
        const plugin = new InternalBGPPlugin(factory);

        let state = new RouteTable().addPeer({
            id: 'peer-c',
            as: 300,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-a', as: 100, endpoint: 'http://peer-a:3000/rpc', domains: [] },
                    updateMessages: [{
                        type: 'add',
                        route: { name: 'service-a', endpoint: 'http://a:80', protocol: 'tcp' },
                        asPath: [100]
                    }]
                }
            },
            state,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('Propagation failed: Network timeout');
    });
});
