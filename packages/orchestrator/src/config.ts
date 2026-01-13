
import { z } from 'zod';

export const OrchestratorConfigSchema = z.object({
    gqlGatewayConfig: z.object({
        endpoint: z.string().url(),
    }).optional(),
    peering: z.object({
        as: z.number().default(100),
        domains: z.array(z.string()).default([]),
        localId: z.string().optional(),
    }).default({}),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export function getConfig(): OrchestratorConfig {
    const gatewayEndpoint = process.env.CATALYST_GQL_GATEWAY_ENDPOINT;

    const config: Partial<OrchestratorConfig> = {};

    if (gatewayEndpoint) {
        console.log(`[Config] Found CATALYST_GQL_GATEWAY_ENDPOINT: ${gatewayEndpoint}`);
        config.gqlGatewayConfig = {
            endpoint: gatewayEndpoint,
        };
    } else {
        console.log('[Config] No CATALYST_GQL_GATEWAY_ENDPOINT found. GraphQL Gateway integration disabled.');
    }

    // Peering Config
    const asNumber = process.env.CATALYST_AS ? parseInt(process.env.CATALYST_AS, 10) : undefined;
    const domains = process.env.CATALYST_DOMAINS ? process.env.CATALYST_DOMAINS.split(',').map(d => d.trim()) : undefined;
    const localId = process.env.CATALYST_NODE_ID;

    if (asNumber || domains || localId) {
        config.peering = {
            as: asNumber ?? 100,
            domains: domains ?? [],
            localId: localId
        };
    }


    // Validate the config
    try {
        return OrchestratorConfigSchema.parse(config);
    } catch (error) {
        console.error('[Config] Invalid configuration:', error);
        throw error;
    }
}
