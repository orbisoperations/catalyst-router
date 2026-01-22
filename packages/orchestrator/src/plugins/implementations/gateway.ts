/**
 * GatewayIntegrationPlugin - Configures external GraphQL gateway with route schemas.
 *
 * ARCHITECTURE: Event-driven with incremental updates.
 * Maintains internal service list, updates from events directly (no stateProvider needed).
 * Listens to ALL route events (both local AND peer) to enable cross-node gateway federation.
 */

import { BasePlugin } from '../base.js';
import { PluginContext, PluginResult } from '../types.js';
import { eventBus, RouteEvent } from '../../events/index.js';

type RouteEventHandler = (event: RouteEvent) => void;

interface ServiceConfig {
    name: string;
    url: string;
    token?: string;
}

export class GatewayIntegrationPlugin extends BasePlugin {
    name = 'GatewayIntegrationPlugin';
    private endpoint: string;
    private triggers: string[];
    private isSubscribed = false;
    private boundHandler?: RouteEventHandler;
    // Internal service list - updated incrementally from events
    private services = new Map<string, ServiceConfig>();

    constructor(
        config: { endpoint: string },
        options: { triggerOnResources?: string[] } = {}
    ) {
        super();
        if (!config) {
            throw new Error('GatewayIntegrationPlugin requires config with endpoint');
        }
        this.endpoint = config.endpoint;
        this.triggers = options.triggerOnResources || [];
    }

    private isGraphQL(protocol: string): boolean {
        return protocol === 'http:graphql' || protocol === 'http:gql';
    }

    /**
     * Start listening for route events and updating the gateway.
     */
    start(): void {
        if (this.isSubscribed) return;

        this.boundHandler = (event: RouteEvent) => this.handleRouteEvent(event);
        eventBus.onAllRouteEvents(this.boundHandler);
        this.isSubscribed = true;
        console.log(`[${this.name}] Subscribed to route events (event-driven mode)`);
    }

    /**
     * Stop listening for route events.
     */
    stop(): void {
        if (this.boundHandler) {
            eventBus.offAllRouteEvents(this.boundHandler);
            this.boundHandler = undefined;
        }
        this.isSubscribed = false;
        this.services.clear();
    }

    private handleRouteEvent(event: RouteEvent): void {
        const { route } = event;

        // Only track GraphQL services
        if (!this.isGraphQL(route.protocol)) return;
        if (!route.endpoint) return;

        // Update internal service list from event data
        if (event.type === 'route:created' || event.type === 'route:updated') {
            this.services.set(route.id, {
                name: route.name,
                url: route.endpoint,
                token: undefined
            });
        } else if (event.type === 'route:deleted') {
            this.services.delete(route.id);
        }

        // Send updated config to gateway
        this.sendUpdate();
    }

    private sendUpdate(): void {
        const services = [...this.services.values()];
        console.log(`[${this.name}] Configuring Gateway at ${this.endpoint} with ${services.length} services`);

        this.sendConfigToGateway({ services }).catch(err => {
            console.error(`[${this.name}] Gateway update error:`, err);
        });
    }

    /**
     * Action-triggered mode (backward compatibility).
     * Only used when not in event-driven mode (start() not called).
     */
    async apply(context: PluginContext): Promise<PluginResult> {
        const { action, state } = context;

        // If using event-driven mode, skip action-triggered behavior
        if (this.isSubscribed) {
            return { success: true, ctx: context };
        }

        // Check if action matches any trigger
        if (!this.triggers.includes(action.resource)) {
            return { success: true, ctx: context };
        }

        console.log(`[${this.name}] Configuring Gateway at ${this.endpoint} (action-triggered)`);

        // Map RouteTable to GatewayConfig
        // We use getAllRoutes() to aggregate proxied, internal, external.
        const services = state.getAllRoutes()
            .map(r => r.service) // Extract ServiceDefinition
            // Filter strictly for GraphQL protocols.
            .filter(s => s.endpoint && this.isGraphQL(s.protocol))
            .map(s => ({
                name: s.name,
                url: s.endpoint!,
                token: undefined
            }));

        const config = { services };

        try {
            await this.sendConfigToGateway(config);
        } catch (error: any) {
            console.error('[GatewayIntegrationPlugin] Failed to update gateway:', error);
            return {
                success: false,
                ctx: context,
                error: {
                    pluginName: this.name,
                    message: `Gateway update failed: ${error.message}`,
                    error
                }
            };
        }

        return { success: true, ctx: context };
    }

    // Method to send config to gateway via WebSocket RPC
    async sendConfigToGateway(config: any) {
        // Dynamic import to avoid strict dependency if not configured
        const { newWebSocketRpcSession } = await import('capnweb');

        console.log(`[${this.name}] Connecting to ${this.endpoint}...`);

        try {
            // newWebSocketRpcSession returns a stub (Proxy) for the remote service
            const gateway = newWebSocketRpcSession(this.endpoint);

            // Invoke the method. newWebSocketRpcSession manages the connection.
            // @ts-expect-error - Dynamic usage or loose typing to match remote method
            const resultPromise = gateway.updateConfig(config);
            const result = await resultPromise;

            if (!result.success) {
                throw new Error(result.error);
            }

            console.log(`[${this.name}] Gateway configuration updated successfully.`);

            // The session might stay open. We don't have an explicit close on the stub itself
            // without accessing hidden session state or if capnweb exports session helper.
            // For now, let it be cleaned up or persisted.

        } catch (error: any) {
            console.error(`[${this.name}] RPC Error:`, error);
            throw error;
        }
    }
}
