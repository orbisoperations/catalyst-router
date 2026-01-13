
import { ServiceDefinition, LocalRoute, DataChannelMetrics } from '../rpc/schema/index.js';

export class RouteTable {
    private routes: Map<string, LocalRoute> = new Map();
    private metrics: Map<string, DataChannelMetrics> = new Map();

    constructor() { }

    addRoute(service: ServiceDefinition): string {
        const id = `${service.name}:${service.protocol}`;
        this.routes.set(id, {
            id,
            service,
        });

        if (!this.metrics.has(id)) {
            this.metrics.set(id, {
                id,
                createdAt: Date.now(),
                connectionCount: 0,
            });
        }

        return id;
    }

    getRoutes(): LocalRoute[] {
        return Array.from(this.routes.values());
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
}

export const GlobalRouteTable = new RouteTable();
