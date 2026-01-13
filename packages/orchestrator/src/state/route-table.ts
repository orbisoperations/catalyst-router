
import { ServiceDefinition, LocalRoute, DataChannelMetrics } from '../rpc/schema/index.js';

export class RouteTable {
    private proxiedRoutes: Map<string, LocalRoute> = new Map();
    private internalRoutes: Map<string, LocalRoute> = new Map();
    private externalRoutes: Map<string, LocalRoute> = new Map();

    private metrics: Map<string, DataChannelMetrics> = new Map();

    constructor() { }

    private createId(service: ServiceDefinition): string {
        return `${service.name}:${service.protocol}`;
    }

    private addRouteToMap(map: Map<string, LocalRoute>, service: ServiceDefinition): string {
        const id = this.createId(service);
        map.set(id, {
            id,
            service,
        });
        this.initMetrics(id);
        return id;
    }

    private initMetrics(id: string) {
        if (!this.metrics.has(id)) {
            this.metrics.set(id, {
                id,
                createdAt: Date.now(),
                connectionCount: 0,
            });
        }
    }

    // Generic add is deprecated in favor of specific methods, but keeping for compatibility if needed.
    // For now, let's map it to internal by default or throw? 
    // The plan said specific methods. Let's redirect generic calls to internal for backward compat with simple tests.
    addRoute(service: ServiceDefinition): string {
        return this.addInternalRoute(service);
    }

    addInternalRoute(service: ServiceDefinition): string {
        return this.addRouteToMap(this.internalRoutes, service);
    }

    addProxiedRoute(service: ServiceDefinition): string {
        return this.addRouteToMap(this.proxiedRoutes, service);
    }

    addExternalRoute(service: ServiceDefinition): string {
        return this.addRouteToMap(this.externalRoutes, service);
    }

    // Returns ALL routes
    getAllRoutes(): LocalRoute[] {
        return [
            ...this.internalRoutes.values(),
            ...this.proxiedRoutes.values(),
            ...this.externalRoutes.values()
        ];
    }

    getInternalRoutes(): LocalRoute[] {
        return Array.from(this.internalRoutes.values());
    }

    getProxiedRoutes(): LocalRoute[] {
        return Array.from(this.proxiedRoutes.values());
    }

    getExternalRoutes(): LocalRoute[] {
        return Array.from(this.externalRoutes.values());
    }

    // Alias for existing tests using getRoutes
    getRoutes(): LocalRoute[] {
        return this.getAllRoutes();
    }

    getMetrics(): DataChannelMetrics[] {
        return Array.from(this.metrics.values());
    }

    recordConnection(id: string) {
        const metric = this.metrics.get(id);
        if (metric) {
            metric.lastConnected = Date.now();
            metric.connectionCount++;
            this.metrics.set(id, metric);
        }
    }

    private updateRouteInMap(map: Map<string, LocalRoute>, service: ServiceDefinition): string | null {
        const id = this.createId(service);
        if (map.has(id)) {
            map.set(id, {
                id,
                service,
            });
            this.initMetrics(id);
            return id;
        }
        return null;
    }

    updateInternalRoute(service: ServiceDefinition): string | null {
        return this.updateRouteInMap(this.internalRoutes, service);
    }

    updateProxiedRoute(service: ServiceDefinition): string | null {
        return this.updateRouteInMap(this.proxiedRoutes, service);
    }

    updateExternalRoute(service: ServiceDefinition): string | null {
        return this.updateRouteInMap(this.externalRoutes, service);
    }

    updateRoute(service: ServiceDefinition): string | null {
        // Try updating in each map, return the first successful update
        const internalId = this.updateInternalRoute(service);
        if (internalId) return internalId;

        const proxiedId = this.updateProxiedRoute(service);
        if (proxiedId) return proxiedId;

        const externalId = this.updateExternalRoute(service);
        if (externalId) return externalId;

        return null;
    }

    removeRoute(id: string) {
        // Try removing from all maps
        this.internalRoutes.delete(id);
        this.proxiedRoutes.delete(id);
        this.externalRoutes.delete(id);
        // Metrics remain for historical reasons or can be removed too?
        // Typically metrics persist for a bit, but for now we leave them.
    }
}

export const GlobalRouteTable = new RouteTable();
