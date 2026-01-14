
import { z } from 'zod';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { RpcTarget } from 'capnweb';
import { newRpcResponse } from '@hono/capnweb';

// Define the configuration schema
export const ServiceConfigSchema = z.object({
    name: z.string(),
    url: z.string(),
    token: z.string().optional(), // Optional auth token for the service
});

export const AuthConfigSchema = z.object({
    jwksUrl: z.string().url(),
    issuer: z.string().optional(),
    audience: z.string().optional(),
});

export const GatewayConfigSchema = z.object({
    services: z.array(ServiceConfigSchema),
    auth: AuthConfigSchema.optional(),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export type ConfigUpdateCallback = (config: GatewayConfig) => Promise<GatewayUpdateResult>;

export const GatewayUpdateResultSchema = z.discriminatedUnion('success', [
    z.object({ success: z.literal(true) }),
    z.object({ success: z.literal(false), error: z.string() }),
]);

export type GatewayUpdateResult = z.infer<typeof GatewayUpdateResultSchema>;

export class GatewayRpcServer extends RpcTarget {
    private updateCallback: ConfigUpdateCallback;

    constructor(updateCallback: ConfigUpdateCallback) {
        super();
        this.updateCallback = updateCallback;
    }

    // The method exposed to RPC clients
    async updateConfig(config: unknown): Promise<GatewayUpdateResult> {
        console.log('Received config update via RPC');
        const result = GatewayConfigSchema.safeParse(config);
        if (!result.success) {
            console.error('Invalid config received.');
            return { success: false, error: 'Malformed configuration received and unable to parse' };
        }

        try {
            return await this.updateCallback(result.data);
        } catch (error: any) {
            console.error('Failed to update configuration:', error);
            return { success: false, error: `Failed to apply configuration: ${error.message}` };
        }
    }
}

export function createRpcHandler(rpcServer: GatewayRpcServer): Hono {
    const app = new Hono();
    app.get('/', (c) => {
        return newRpcResponse(c, rpcServer, {
            upgradeWebSocket,
        });
    });
    return app;
}

