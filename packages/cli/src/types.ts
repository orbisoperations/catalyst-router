import { z } from 'zod';

export type CliResult<T> =
    | { success: true; data?: T }
    | { success: false; error: string };

export const BaseCliConfigSchema = z.object({
    orchestratorUrl: z.string().url().default(process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc'),
    gatewayUrl: z.string().url().default(process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});
export type BaseCliConfig = z.infer<typeof BaseCliConfigSchema>;

// Service definition schema (matches @catalyst/orchestrator schema)
export const ServiceProtocolSchema = z.enum(['tcp', 'udp', 'http', 'http:graphql', 'http:gql', 'http:grpc']);
export type ServiceProtocol = z.infer<typeof ServiceProtocolSchema>;

export const ServiceDefinitionSchema = z.object({
    name: z.string(),
    endpoint: z.string().url(),
    protocol: ServiceProtocolSchema,
    region: z.string().optional(),
});
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;

export const AddServiceInputSchema = ServiceDefinitionSchema.pick({
    name: true,
    endpoint: true,
    protocol: true
}).merge(BaseCliConfigSchema);

export type AddServiceInput = z.infer<typeof AddServiceInputSchema>;

export const ListServicesInputSchema = BaseCliConfigSchema;
export type ListServicesInput = z.infer<typeof ListServicesInputSchema>;

// Data plane types
export const QueryInputSchema = z.object({
    service: z.string(),
    query: z.string().optional(),
    file: z.string().optional(),
    variables: z.string().optional(),
    gatewayUrl: z.string().url().default(process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
});
export type QueryInput = z.infer<typeof QueryInputSchema>;

export const PingInputSchema = z.object({
    service: z.string(),
    count: z.number().default(1),
    gatewayUrl: z.string().url().default(process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
});
export type PingInput = z.infer<typeof PingInputSchema>;

export const TraceInputSchema = z.object({
    service: z.string(),
    gatewayUrl: z.string().url().default(process.env.CATALYST_GATEWAY_URL || 'http://localhost:4000/graphql')
});
export type TraceInput = z.infer<typeof TraceInputSchema>;
