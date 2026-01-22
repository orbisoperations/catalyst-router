import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { IBGPConfigHandler } from '../src/plugins/implementations/ibgp-config-handler.js';
import { IBGPProtocolHandler } from '../src/plugins/implementations/ibgp-protocol-handler.js';
import { RouteBroadcaster } from '../src/plugins/implementations/route-broadcaster.js';
import { RouteTable } from '../src/state/route-table.js';
import { PluginContext } from '../src/plugins/types.js';
import type { IBGPProtocolOpen } from '../src/rpc/schema/peering.js';
import { eventBus, RouteEvent } from '../src/events/index.js';

// Set required environment variables for tests
process.env.CATALYST_PEERING_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.CATALYST_AS = '100';
process.env.CATALYST_IBGP_LOCAL_ID = 'test-node';
process.env.CATALYST_IBGP_ENDPOINT = 'http://localhost:4015/rpc';

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


describe('IBGPProtocolHandler Unit Tests', () => {

    it('should add an internal route when receiving an "add" update', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
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
        const plugin = new IBGPProtocolHandler(mockFactory);
        // Route ID format is: source:name:protocol
        const routeId = 'peer-b:proxied-service:http:graphql';

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

    it('should remove a peer and its routes when receiving a "close" action', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
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
        const plugin = new IBGPProtocolHandler(mockFactory);
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

        const plugin = new IBGPProtocolHandler(factory);

        // Seed state with peer C
        let state = new RouteTable().addPeer({
            id: 'peer-c',
            as: 300,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        // Note: peer-a uses AS 200, different from our AS (100), so no loop detection
        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-a', as: 200, endpoint: 'http://peer-a:3000/rpc', domains: [] },
                    updateMessages: [
                        {
                            type: 'add',
                            route: {
                                name: 'service-a',
                                endpoint: 'http://a-backend:8080',
                                protocol: 'tcp'
                            },
                            asPath: [200]  // Source AS, not our AS (100)
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
        expect(routesOnB[0].asPath).toEqual([200]);
    });

    it('should fail if propagation to transit peer fails', async () => {
        const failingSession = {
            update: async () => ({ success: false, error: 'Network timeout' }),
            open: async () => ({ success: true, peerInfo: { id: 'peer-c', as: 300, endpoint: 'http://peer-c:3000/rpc', domains: [] } }),
        };

        const factory = (endpoint: string) => failingSession as any;
        const plugin = new IBGPProtocolHandler(factory);

        let state = new RouteTable().addPeer({
            id: 'peer-c',
            as: 300,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        // Note: peer-a uses AS 200, different from our AS (100), so route is accepted and propagated
        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-a', as: 200, endpoint: 'http://peer-a:3000/rpc', domains: [] },
                    updateMessages: [{
                        type: 'add',
                        route: { name: 'service-a', endpoint: 'http://a:80', protocol: 'tcp' },
                        asPath: [200]  // Source AS, not our AS (100)
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

describe('RouteBroadcaster Unit Tests (Event-Based)', () => {
    let currentState: RouteTable;
    let updateCallCount: number;
    let lastUpdateMessages: any[];

    const spyFactory = (endpoint: string, secret: string) => ({
        open: async () => ({ success: true, peerInfo: mockPeerInfo }),
        update: async (peerInfo: any, messages: any[]) => {
            updateCallCount++;
            lastUpdateMessages = messages;
            return { success: true };
        },
        close: async () => ({ success: true })
    });

    beforeEach(() => {
        updateCallCount = 0;
        lastUpdateMessages = [];
        eventBus.clear(); // Clear any existing handlers
    });

    afterEach(() => {
        eventBus.clear();
    });

    it('should broadcast when receiving route:created event', async () => {
        // Setup state with a peer
        currentState = new RouteTable().addPeer({
            id: 'peer-b',
            as: 100,
            endpoint: 'http://peer-b:3000/rpc',
            domains: []
        }).state;

        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, spyFactory);
        broadcaster.start();

        // Emit a route:created event
        const event: RouteEvent = {
            type: 'route:created',
            route: {
                id: 'local:test-service:tcp',
                name: 'test-service',
                protocol: 'tcp',
                endpoint: 'http://localhost:8080',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        };
        eventBus.emitRouteEvent(event);

        // Wait for async broadcast
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCallCount).toBe(1);
        expect(lastUpdateMessages[0].type).toBe('add');
        expect(lastUpdateMessages[0].route.name).toBe('test-service');
    });

    it('should broadcast when receiving route:deleted event', async () => {
        currentState = new RouteTable().addPeer({
            id: 'peer-c',
            as: 100,
            endpoint: 'http://peer-c:3000/rpc',
            domains: []
        }).state;

        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, spyFactory);
        broadcaster.start();

        const event: RouteEvent = {
            type: 'route:deleted',
            route: {
                id: 'local:deleted-service:tcp',
                name: 'deleted-service',
                protocol: 'tcp',
                endpoint: 'http://localhost:8080',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        };
        eventBus.emitRouteEvent(event);

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCallCount).toBe(1);
        expect(lastUpdateMessages[0].type).toBe('remove');
        expect(lastUpdateMessages[0].routeId).toBe('local:deleted-service:tcp');
    });

    it('should NOT broadcast events from peers (only local)', async () => {
        currentState = new RouteTable().addPeer({
            id: 'peer-d',
            as: 100,
            endpoint: 'http://peer-d:3000/rpc',
            domains: []
        }).state;

        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, spyFactory);
        broadcaster.start();

        // Event from peer, not local
        const event: RouteEvent = {
            type: 'route:created',
            route: {
                id: 'peer-x:remote-service:tcp',
                name: 'remote-service',
                protocol: 'tcp',
                endpoint: 'http://remote:8080',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'peer',  // <-- From peer, should be ignored
            peerId: 'peer-x'
        };
        eventBus.emitRouteEvent(event);

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCallCount).toBe(0); // Should NOT have broadcast
    });

    it('should broadcast to multiple peers', async () => {
        currentState = new RouteTable()
            .addPeer({ id: 'peer-1', as: 100, endpoint: 'http://peer-1:3000/rpc', domains: [] }).state
            .addPeer({ id: 'peer-2', as: 100, endpoint: 'http://peer-2:3000/rpc', domains: [] }).state;

        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, spyFactory);
        broadcaster.start();

        const event: RouteEvent = {
            type: 'route:created',
            route: {
                id: 'local:multi-service:tcp',
                name: 'multi-service',
                protocol: 'tcp',
                endpoint: 'http://localhost:8080',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        };
        eventBus.emitRouteEvent(event);

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCallCount).toBe(2); // One call per peer
    });
});

describe('IBGPProtocolHandler Event Emission', () => {
    /**
     * These tests verify that IBGPProtocolHandler emits route events
     * when receiving peer routes, enabling event-driven consumers
     * (like GatewayIntegrationPlugin) to react to peer route changes.
     */

    let emittedEvents: RouteEvent[];

    beforeEach(() => {
        emittedEvents = [];
        eventBus.clear();

        // Capture all route events
        eventBus.onAllRouteEvents((event: RouteEvent) => {
            emittedEvents.push(event);
        });
    });

    afterEach(() => {
        eventBus.clear();
    });

    it('should emit route:created event with source=peer when receiving add update', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
        const initialState = new RouteTable();

        const route = {
            name: 'peer-service',
            endpoint: 'http://peer:8080/graphql',
            protocol: 'http:graphql' as any
        };

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-x', as: 200, endpoint: 'http://peer-x:3000/rpc', domains: [] },
                    updateMessages: [{ type: 'add', route, asPath: [200] }]
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);

        // Verify event was emitted
        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0].type).toBe('route:created');
        expect(emittedEvents[0].source).toBe('peer');
        expect(emittedEvents[0].peerId).toBe('peer-x');
        expect(emittedEvents[0].route.name).toBe('peer-service');
        expect(emittedEvents[0].route.protocol).toBe('http:graphql');
    });

    it('should emit route:deleted event with source=peer when receiving remove update', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
        const routeId = 'peer-y:deletable-service:tcp';

        // Seed state with a route to delete
        const seedState = new RouteTable().addInternalRoute({
            name: 'deletable-service',
            endpoint: 'http://remote:8080',
            protocol: 'tcp'
        }, 'peer-y').state;

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-y', as: 200, endpoint: 'http://peer-y:3000/rpc', domains: [] },
                    updateMessages: [{ type: 'remove', routeId }]
                }
            },
            state: seedState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);

        // Verify event was emitted
        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0].type).toBe('route:deleted');
        expect(emittedEvents[0].source).toBe('peer');
        expect(emittedEvents[0].peerId).toBe('peer-y');
        expect(emittedEvents[0].route.id).toBe(routeId);
    });

    it('should NOT emit event when route is dropped due to loop detection', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
        const initialState = new RouteTable();

        // AS path includes our own AS (100) - should be dropped
        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-z', as: 200, endpoint: 'http://peer-z:3000/rpc', domains: [] },
                    updateMessages: [{
                        type: 'add',
                        route: { name: 'looped-service', endpoint: 'http://x:80', protocol: 'tcp' },
                        asPath: [200, 100]  // Contains our AS (100) - loop!
                    }]
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);

        // No event should be emitted for dropped routes
        expect(emittedEvents).toHaveLength(0);
    });

    it('should emit events for each route in batch update', async () => {
        const plugin = new IBGPProtocolHandler(mockFactory);
        const initialState = new RouteTable();

        const context: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'update',
                data: {
                    peerInfo: { id: 'peer-batch', as: 200, endpoint: 'http://peer-batch:3000/rpc', domains: [] },
                    updateMessages: [
                        { type: 'add', route: { name: 'service-1', endpoint: 'http://s1:80', protocol: 'tcp' }, asPath: [200] },
                        { type: 'add', route: { name: 'service-2', endpoint: 'http://s2:80', protocol: 'tcp' }, asPath: [200] },
                        { type: 'add', route: { name: 'service-3', endpoint: 'http://s3:80', protocol: 'tcp' }, asPath: [200] }
                    ]
                }
            },
            state: initialState,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        expect(result.success).toBe(true);

        // Should emit 3 events, one for each route
        expect(emittedEvents).toHaveLength(3);
        expect(emittedEvents.map(e => e.route.name).sort()).toEqual(['service-1', 'service-2', 'service-3']);
        expect(emittedEvents.every(e => e.source === 'peer')).toBe(true);
    });
});

describe('Event-Based Route Broadcasting (Stale State Fix)', () => {
    /**
     * These tests verify that the event-based architecture fixes the stale state bug.
     *
     * OLD PATTERN (buggy):
     *   - RouteBroadcaster was a plugin intercepting localRoute actions
     *   - It captured state in closures, which could become stale
     *
     * NEW PATTERN (fixed):
     *   - LocalRoutingPlugin emits events AFTER state is committed
     *   - RouteBroadcaster subscribes to events and reads fresh state
     *   - No closure capture = no stale state
     */

    let currentState: RouteTable;
    let routesSentToPeer: any[];

    const trackingFactory = (endpoint: string, secret: string) => ({
        open: async () => ({ success: true, peerInfo: { id: 'test', as: 100, endpoint, domains: [] } }),
        update: async (peerInfo: any, updates: any[]) => {
            routesSentToPeer.push(...updates);
            return { success: true };
        },
        close: async () => ({ success: true })
    });

    beforeEach(() => {
        routesSentToPeer = [];
        eventBus.clear();
    });

    afterEach(() => {
        eventBus.clear();
    });

    it('event-based broadcast uses fresh state, not stale closure', async () => {
        // Setup: state with one peer
        currentState = new RouteTable().addPeer({
            id: 'peer-A',
            as: 200,
            endpoint: 'http://peer-a:4000/rpc',
            domains: []
        }).state;

        // The state provider always returns CURRENT state (not captured at subscription time)
        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, trackingFactory);
        broadcaster.start();

        // Simulate: LocalRoutingPlugin adds a route and emits event
        const { state: stateWithRoute, id } = currentState.addInternalRoute({
            name: 'fresh-service',
            endpoint: 'http://localhost:8080',
            protocol: 'tcp'
        });
        currentState = stateWithRoute; // Update current state BEFORE event

        // Emit the event (this is what LocalRoutingPlugin does)
        const event: RouteEvent = {
            type: 'route:created',
            route: {
                id,
                name: 'fresh-service',
                protocol: 'tcp',
                endpoint: 'http://localhost:8080',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        };
        eventBus.emitRouteEvent(event);

        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify: broadcast happened with fresh data
        expect(routesSentToPeer.length).toBe(1);
        expect(routesSentToPeer[0].route.name).toBe('fresh-service');
    });

    it('multiple rapid route additions all get broadcast (no race condition)', async () => {
        currentState = new RouteTable().addPeer({
            id: 'peer-B',
            as: 300,
            endpoint: 'http://peer-b:4000/rpc',
            domains: []
        }).state;

        const stateProvider = () => currentState;
        const broadcaster = new RouteBroadcaster(stateProvider, trackingFactory);
        broadcaster.start();

        // Rapidly add multiple routes
        for (let i = 1; i <= 3; i++) {
            const { state: newState, id } = currentState.addInternalRoute({
                name: `service-${i}`,
                endpoint: `http://localhost:${8080 + i}`,
                protocol: 'tcp'
            });
            currentState = newState;

            eventBus.emitRouteEvent({
                type: 'route:created',
                route: {
                    id,
                    name: `service-${i}`,
                    protocol: 'tcp',
                    endpoint: `http://localhost:${8080 + i}`,
                    routeType: 'internal'
                },
                timestamp: Date.now(),
                source: 'local'
            });
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        // All 3 routes should be broadcast
        expect(routesSentToPeer.length).toBe(3);
        expect(routesSentToPeer.map(u => u.route.name).sort()).toEqual(['service-1', 'service-2', 'service-3']);
    });

    it('new peer added after routes exist gets synced via OPEN (not events)', async () => {
        // This tests the OPEN sync path, which is separate from event-based broadcast
        const plugin = new IBGPProtocolHandler(trackingFactory);

        // State with existing route but no peers yet
        const { state: stateWithRoute } = new RouteTable().addInternalRoute({
            name: 'existing-service',
            endpoint: 'http://localhost:8080',
            protocol: 'tcp'
        });

        const openContext: PluginContext = {
            action: {
                resource: 'internalBGP',
                resourceAction: 'open',
                data: {
                    peerInfo: {
                        id: 'new-peer',
                        as: 200,
                        endpoint: 'http://new-peer:4000/rpc',
                        domains: []
                    }
                }
            } as IBGPProtocolOpen,
            state: stateWithRoute,
            results: [],
            authxContext: {} as any
        };

        const result = await plugin.apply(openContext);
        expect(result.success).toBe(true);

        // Wait for background sync (setImmediate in handleOpen)
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 50));

        // The existing route should have been synced to the new peer
        expect(routesSentToPeer.length).toBe(1);
        expect(routesSentToPeer[0].route.name).toBe('existing-service');
    });
});
