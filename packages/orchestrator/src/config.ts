
import { z } from 'zod';

export const OrchestratorConfigSchema = z.object({
    gqlGatewayConfig: z.object({
        endpoint: z.string().url(),
    }).optional(),
    peering: z.object({
        localId: z.string().optional(),
        as: z.number().default(0),
        domains: z.array(z.string()).default([]),
    }).default({}),
    port: z.number().default(3000),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function getConfig(): OrchestratorConfig {
    const gatewayEndpoint = process.env.CATALYST_GQL_GATEWAY_ENDPOINT;
    const peeringAs = process.env.CATALYST_AS;
    const peeringDomains = process.env.CATALYST_DOMAINS; // Comma separated
    const peeringNodeId = process.env.CATALYST_NODE_ID;
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

    const config: any = {
        port,
        peering: {
            as: peeringAs ? parseInt(peeringAs) : 0,
            domains: peeringDomains ? peeringDomains.split(',').map(d => d.trim()) : [],
            localId: peeringNodeId
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
