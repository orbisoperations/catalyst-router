import type { CliResult } from './types.js';

export interface DataClientConfig {
    gatewayUrl: string;
    token?: string;
}

export interface GraphQLResponse {
    data?: unknown;
    errors?: Array<{ message: string; path?: string[] }>;
}

export interface PingResult {
    success: boolean;
    latency: number;
    timestamp: string;
}

export interface TraceResult {
    hops: Array<{
        node: string;
        latency: number;
        timestamp: string;
    }>;
    totalLatency: number;
}

export class DataClient {
    private config: DataClientConfig;

    constructor(config: DataClientConfig) {
        this.config = config;
    }

    /**
     * Execute a GraphQL query against the Gateway
     */
    async query(query: string, variables?: Record<string, unknown>): Promise<CliResult<GraphQLResponse>> {
        try {
            const response = await fetch(this.config.gatewayUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
                },
                body: JSON.stringify({ query, variables }),
            });

            if (!response.ok) {
                return {
                    success: false,
                    error: `HTTP ${response.status}: ${response.statusText}`,
                };
            }

            const result = await response.json() as GraphQLResponse;

            if (result.errors && result.errors.length > 0) {
                return {
                    success: false,
                    error: result.errors.map(e => e.message).join(', '),
                };
            }

            return { success: true, data: result };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, error: message };
        }
    }

    /**
     * Ping a service through the Gateway to test connectivity
     */
    async ping(serviceName: string): Promise<CliResult<PingResult>> {
        const startTime = Date.now();
        
        try {
            // Use introspection query as a simple ping
            const query = `query { __typename }`;
            
            const response = await fetch(this.config.gatewayUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
                },
                body: JSON.stringify({ query }),
            });

            const endTime = Date.now();
            const latency = endTime - startTime;

            if (!response.ok) {
                return {
                    success: false,
                    error: `HTTP ${response.status}: ${response.statusText}`,
                };
            }

            const result = await response.json() as GraphQLResponse;

            if (result.errors && result.errors.length > 0) {
                return {
                    success: false,
                    error: result.errors.map(e => e.message).join(', '),
                };
            }

            return {
                success: true,
                data: {
                    success: true,
                    latency,
                    timestamp: new Date().toISOString(),
                },
            };
        } catch (err: unknown) {
            const endTime = Date.now();
            const latency = endTime - startTime;
            const message = err instanceof Error ? err.message : String(err);
            
            return {
                success: false,
                error: message,
                data: {
                    success: false,
                    latency,
                    timestamp: new Date().toISOString(),
                },
            };
        }
    }

    /**
     * Trace a request through the mesh
     * This would use special headers in a production implementation
     */
    async trace(serviceName: string): Promise<CliResult<TraceResult>> {
        const startTime = Date.now();
        
        try {
            // In a real implementation, this would use trace headers
            // For now, we'll simulate with a simple query
            const query = `query { __typename }`;
            
            const response = await fetch(this.config.gatewayUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Request': 'true',
                    ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
                },
                body: JSON.stringify({ query }),
            });

            const endTime = Date.now();
            const totalLatency = endTime - startTime;

            if (!response.ok) {
                return {
                    success: false,
                    error: `HTTP ${response.status}: ${response.statusText}`,
                };
            }

            // In production, trace data would come from response headers or body
            // For now, return a simple trace result
            const result: TraceResult = {
                hops: [
                    {
                        node: 'Gateway',
                        latency: totalLatency,
                        timestamp: new Date().toISOString(),
                    },
                ],
                totalLatency,
            };

            return { success: true, data: result };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, error: message };
        }
    }
}

/**
 * Create a data plane client instance
 */
export function createDataClient(gatewayUrl?: string, token?: string): DataClient {
    const url = gatewayUrl || process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql';
    return new DataClient({ gatewayUrl: url, token });
}
