import { z } from 'zod';
import os from 'os';

export const OrchestratorConfigSchema = z.object({
    gqlGatewayConfig: z.object({
        endpoint: z.string().url(),
    }).optional(),
    as: z.number().default(0),
    ibgp: z.object({
        localId: z.string().optional(),
        endpoint: z.string().url().optional(),
        domains: z.array(z.string()).default([]),
        secret: z.string().default('valid-secret'),
        transport: z.enum(['http', 'websocket']).default('http')
    }).default({ domains: [], secret: 'valid-secret', transport: 'http' }),
    port: z.number().default(3000),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function getConfig(): OrchestratorConfig {
    const gatewayEndpoint = process.env.CATALYST_GQL_GATEWAY_ENDPOINT;
    const peeringAs = process.env.CATALYST_AS;
    const peeringDomains = process.env.CATALYST_DOMAINS; // Comma separated
    const peeringNodeId = process.env.CATALYST_NODE_ID;
    const peeringEndpoint = process.env.CATALYST_PEERING_ENDPOINT;
    const peeringSecret = process.env.CATALYST_PEERING_SECRET;
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    const peeringTransport = process.env.CATALYST_IBGP_TRANSPORT; // 'http' | 'websocket'

    const config: Record<string, unknown> = {
        port,
        as: peeringAs ? parseInt(peeringAs) : 0,
        ibgp: {
            domains: peeringDomains ? peeringDomains.split(',').map(d => d.trim()) : [],
            localId: peeringNodeId || os.hostname(),
            endpoint: peeringEndpoint,
            secret: peeringSecret || 'valid-secret',
            transport: peeringTransport === 'websocket' ? 'websocket' : 'http'
        }
    };

    if (gatewayEndpoint) {
        console.log(`[Config] Found CATALYST_GQL_GATEWAY_ENDPOINT: ${gatewayEndpoint}`);
        config.gqlGatewayConfig = {
            endpoint: gatewayEndpoint,
        };
    } else {
        console.log('[Config] No CATALYST_GQL_GATEWAY_ENDPOINT found. GraphQL Gateway integration disabled.');
    }

    // Validate the config
    try {
        return OrchestratorConfigSchema.parse(config);
    } catch (error) {
        console.error('[Config] Invalid configuration:', error);
        throw error;
    }
}
