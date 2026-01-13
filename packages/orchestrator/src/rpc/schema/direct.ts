
import { z } from 'zod';

export const ServiceProtocolSchema = z.enum(['tcp', 'tcp:http', 'tcp:graphql', 'tcp:gql', 'tcp:grpc', 'udp']);
export type ServiceProtocol = z.infer<typeof ServiceProtocolSchema>;

export const ServiceDefinitionSchema = z.object({
    name: z.string(),
    fqdn: z.string(), // Logical FQDN (e.g., service.internal)
    endpoint: z.string().url(),
    protocol: ServiceProtocolSchema,
    region: z.string().optional(),
    authEndpoint: z.string().url().optional(), // For internal AS
    jwks: z.string().optional(), // For external AS (URL or JSON)
});
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;
