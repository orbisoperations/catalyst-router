import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { GatewayIntegrationPlugin } from '../src/plugins/implementations/gateway.js';
import { eventBus, RouteEvent } from '../src/events/index.js';

// Set required environment variables for tests
process.env.CATALYST_PEERING_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.CATALYST_AS = '100';
process.env.CATALYST_IBGP_LOCAL_ID = 'test-node';
process.env.CATALYST_IBGP_ENDPOINT = 'http://localhost:4015/rpc';

describe('GatewayIntegrationPlugin (Event-Driven)', () => {
    /**
     * These tests verify the event-driven GatewayIntegrationPlugin:
     * 1. Subscribes to route events on start()
     * 2. Maintains internal service list from events
     * 3. Updates gateway when ANY route event occurs (not just local)
     * 4. Filters for GraphQL services only
     * 5. Properly cleans up subscriptions on stop()
     */

    let updateCalls: any[];
    let plugin: GatewayIntegrationPlugin;

    beforeEach(() => {
        updateCalls = [];
        eventBus.clear();
    });

    afterEach(() => {
        if (plugin) {
            plugin.stop();
        }
        eventBus.clear();
    });

    function createPlugin(): GatewayIntegrationPlugin {
        const p = new GatewayIntegrationPlugin({ endpoint: 'ws://test-gateway:4000' });

        // Mock the sendConfigToGateway method
        p.sendConfigToGateway = async (config: any) => {
            updateCalls.push(config);
        };

        return p;
    }

    it('should subscribe to route events and update gateway on route:created', async () => {
        plugin = createPlugin();
        plugin.start();

        // Emit a route:created event
        const event: RouteEvent = {
            type: 'route:created',
            route: {
                id: 'local:test-gql-service:http:graphql',
                name: 'test-gql-service',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        };
        eventBus.emitRouteEvent(event);

        // Wait for async processing
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].services).toHaveLength(1);
        expect(updateCalls[0].services[0].name).toBe('test-gql-service');
    });

    it('should update gateway for both local AND peer route events', async () => {
        plugin = createPlugin();
        plugin.start();

        // Emit a local route event
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:local-gql:http:graphql',
                name: 'local-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].services).toHaveLength(1);

        // Now emit a peer route event
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'peer-a:peer-gql:http:graphql',
                name: 'peer-gql',
                protocol: 'http:graphql',
                endpoint: 'http://peer:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'peer',
            peerId: 'peer-a'
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        // Should have updated gateway again for peer route
        expect(updateCalls).toHaveLength(2);
        // The second update should include BOTH services (incremental)
        expect(updateCalls[1].services).toHaveLength(2);
    });

    it('should update gateway when routes are deleted', async () => {
        plugin = createPlugin();
        plugin.start();

        // First add a route
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:deletable-gql:http:graphql',
                name: 'deletable-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(updateCalls[0].services).toHaveLength(1);

        // Now delete the route
        eventBus.emitRouteEvent({
            type: 'route:deleted',
            route: {
                id: 'local:deletable-gql:http:graphql',
                name: 'deletable-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(updateCalls).toHaveLength(2);
        // After deletion, no services should be in the config
        expect(updateCalls[1].services).toHaveLength(0);
    });

    it('should only include GraphQL services in gateway config', async () => {
        plugin = createPlugin();
        plugin.start();

        // Emit GraphQL route
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:gql-service:http:graphql',
                name: 'gql-service',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        // Emit another GraphQL route (http:gql variant)
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:gql-service-2:http:gql',
                name: 'gql-service-2',
                protocol: 'http:gql',
                endpoint: 'http://localhost:8081/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        // Emit non-GraphQL route (should be ignored)
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:tcp-service:tcp',
                name: 'tcp-service',
                protocol: 'tcp',
                endpoint: 'http://localhost:9000',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        // Only 2 updates (for GraphQL routes), tcp was ignored
        expect(updateCalls).toHaveLength(2);
        // Final state should have 2 GraphQL services
        expect(updateCalls[1].services).toHaveLength(2);
        const names = updateCalls[1].services.map((s: any) => s.name).sort();
        expect(names).toEqual(['gql-service', 'gql-service-2']);
    });

    it('should stop listening when stop() is called', async () => {
        plugin = createPlugin();
        plugin.start();

        // First event should trigger update
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:test-gql:http:graphql',
                name: 'test-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(updateCalls).toHaveLength(1);

        // Stop the plugin
        plugin.stop();

        // Second event should NOT trigger update
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:another-gql:http:graphql',
                name: 'another-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8081/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        // Should still be 1, no new updates
        expect(updateCalls).toHaveLength(1);
    });

    it('should not subscribe twice if start() is called multiple times', async () => {
        plugin = createPlugin();
        plugin.start();
        plugin.start(); // Call again
        plugin.start(); // And again

        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:test-gql:http:graphql',
                name: 'test-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        // Should only have 1 update, not 3
        expect(updateCalls).toHaveLength(1);
    });

    it('should clear internal services on stop()', async () => {
        plugin = createPlugin();
        plugin.start();

        // Add a service
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:test-gql:http:graphql',
                name: 'test-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8080/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(updateCalls[0].services).toHaveLength(1);

        // Stop and restart
        plugin.stop();
        plugin.start();

        // Emit a new event - should only have this one service, not the old one
        eventBus.emitRouteEvent({
            type: 'route:created',
            route: {
                id: 'local:new-gql:http:graphql',
                name: 'new-gql',
                protocol: 'http:graphql',
                endpoint: 'http://localhost:8081/graphql',
                routeType: 'internal'
            },
            timestamp: Date.now(),
            source: 'local'
        });

        await new Promise(resolve => setTimeout(resolve, 50));
        // Should only have the new service, not the old one
        expect(updateCalls[updateCalls.length - 1].services).toHaveLength(1);
        expect(updateCalls[updateCalls.length - 1].services[0].name).toBe('new-gql');
    });
});
