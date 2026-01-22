import { ServiceDefinition, LocalRoute, DataChannelMetrics } from '../rpc/schema/index.js';
import { AuthorizedPeer } from '../rpc/schema/peering.js';

export class RouteTable {
    constructor(
        private proxiedRoutes: Map<string, LocalRoute> = new Map(),
        private internalRoutes: Map<string, LocalRoute> = new Map(),
        private externalRoutes: Map<string, LocalRoute> = new Map(),
        private metrics: Map<string, DataChannelMetrics> = new Map(),
        private peers: Map<string, AuthorizedPeer> = new Map()
    ) { }

    private createId(service: ServiceDefinition): string {
        return `${service.name}:${service.protocol}`;
    }

    // Helper to create a new instance with updated fields
    private clone(updates: {
        proxiedRoutes?: Map<string, LocalRoute>,
        internalRoutes?: Map<string, LocalRoute>,
        externalRoutes?: Map<string, LocalRoute>,
        metrics?: Map<string, DataChannelMetrics>,
        peers?: Map<string, AuthorizedPeer>
    }): RouteTable {
        return new RouteTable(
            updates.proxiedRoutes ?? this.proxiedRoutes,
            updates.internalRoutes ?? this.internalRoutes,
            updates.externalRoutes ?? this.externalRoutes,
            updates.metrics ?? this.metrics,
            updates.peers ?? this.peers
        );
    }

    private addRouteToMap(
        currentMap: Map<string, LocalRoute>,
        service: ServiceDefinition
    ): { map: Map<string, LocalRoute>, metrics: Map<string, DataChannelMetrics>, id: string } {
        const id = this.createId(service);
        const newMap = new Map(currentMap);
        newMap.set(id, {
            id,
            service,
        });

        const newMetrics = new Map(this.metrics);
        if (!newMetrics.has(id)) {
            newMetrics.set(id, {
                id,
                createdAt: Date.now(),
                connectionCount: 0,
            });
        }

        return { map: newMap, metrics: newMetrics, id };
    }

    addRoute(service: ServiceDefinition): { state: RouteTable, id: string } {
        return this.addInternalRoute(service);
    }

    addInternalRoute(service: ServiceDefinition): { state: RouteTable, id: string } {
        const { map, metrics, id } = this.addRouteToMap(this.internalRoutes, service);
        return {
            state: this.clone({ internalRoutes: map, metrics }),
            id
        };
    }

    addProxiedRoute(service: ServiceDefinition): { state: RouteTable, id: string } {
        const { map, metrics, id } = this.addRouteToMap(this.proxiedRoutes, service);
        return {
            state: this.clone({ proxiedRoutes: map, metrics }),
            id
        };
    }

    addExternalRoute(service: ServiceDefinition): { state: RouteTable, id: string } {
        const { map, metrics, id } = this.addRouteToMap(this.externalRoutes, service);
        return {
            state: this.clone({ externalRoutes: map, metrics }),
            id
        };
    }

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

    getRoutes(): LocalRoute[] {
        return this.getAllRoutes();
    }

    getMetrics(): DataChannelMetrics[] {
        return Array.from(this.metrics.values());
    }

    recordConnection(id: string): RouteTable {
        const metric = this.metrics.get(id);
        if (metric) {
            const newMetrics = new Map(this.metrics);
            newMetrics.set(id, {
                ...metric,
                lastConnected: Date.now(),
                connectionCount: metric.connectionCount + 1
            });
            return this.clone({ metrics: newMetrics });
        }
        return this;
    }

    private updateRouteInMap(
        currentMap: Map<string, LocalRoute>,
        service: ServiceDefinition
    ): { map: Map<string, LocalRoute>, id: string } | null {
        const id = this.createId(service);
        if (currentMap.has(id)) {
            const newMap = new Map(currentMap);
            newMap.set(id, {
                id,
                service,
            });
            // Init metrics if missing (safety check)
            // But usually update happens after add.
            // For immutability, we assume metrics exist or we don't touch them here unless needed.
            return { map: newMap, id };
        }
        return null;
    }

    updateInternalRoute(service: ServiceDefinition): { state: RouteTable, id: string } | null {
        const result = this.updateRouteInMap(this.internalRoutes, service);
        if (result) {
            return { state: this.clone({ internalRoutes: result.map }), id: result.id };
        }
        return null;
    }

    updateProxiedRoute(service: ServiceDefinition): { state: RouteTable, id: string } | null {
        const result = this.updateRouteInMap(this.proxiedRoutes, service);
        if (result) {
            return { state: this.clone({ proxiedRoutes: result.map }), id: result.id };
        }
        return null;
    }

    updateExternalRoute(service: ServiceDefinition): { state: RouteTable, id: string } | null {
        const result = this.updateRouteInMap(this.externalRoutes, service);
        if (result) {
            return { state: this.clone({ externalRoutes: result.map }), id: result.id };
        }
        return null;
    }

    updateRoute(service: ServiceDefinition): { state: RouteTable, id: string } | null {
        // Try updating in each map, return the first successful update
        const internalRes = this.updateInternalRoute(service);
        if (internalRes) return internalRes;

        const proxiedRes = this.updateProxiedRoute(service);
        if (proxiedRes) return proxiedRes;

        const externalRes = this.updateExternalRoute(service);
        if (externalRes) return externalRes;

        return null;
    }

    removeRoute(id: string): RouteTable {
        let changed = false;
        let newInternal = this.internalRoutes;
        let newProxied = this.proxiedRoutes;
        let newExternal = this.externalRoutes;

        if (newInternal.has(id)) {
            newInternal = new Map(newInternal);
            newInternal.delete(id);
            changed = true;
        }
        if (newProxied.has(id)) {
            newProxied = new Map(newProxied);
            newProxied.delete(id);
            changed = true;
        }
        if (newExternal.has(id)) {
            newExternal = new Map(newExternal);
            newExternal.delete(id);
            changed = true;
        }

        if (changed) {
            return this.clone({
                internalRoutes: newInternal,
                proxiedRoutes: newProxied,
                externalRoutes: newExternal
            });
        }
        return this;
    }

    // Peering Management
    addPeer(peer: AuthorizedPeer): { state: RouteTable, id: string } {
        const newPeers = new Map(this.peers);
        newPeers.set(peer.id, peer);
        return {
            state: this.clone({ peers: newPeers }),
            id: peer.id
        };
    }

    removePeer(id: string): RouteTable {
        if (this.peers.has(id)) {
            const newPeers = new Map(this.peers);
            newPeers.delete(id);
            return this.clone({ peers: newPeers });
        }
        return this;
    }

    getPeers(): AuthorizedPeer[] {
        return Array.from(this.peers.values());
    }

    getPeer(id: string): AuthorizedPeer | undefined {
        return this.peers.get(id);
    }
}

export const GlobalRouteTable = new RouteTable();
