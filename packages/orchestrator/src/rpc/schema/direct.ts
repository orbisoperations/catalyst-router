
import { z } from 'zod';

export const ServiceProtocolSchema = z.enum(['tcp', 'tcp:http', 'tcp:graphql', 'tcp:gql', 'tcp:grpc', 'udp']);
export type ServiceProtocol = z.infer<typeof ServiceProtocolSchema>;

export const ServiceDefinitionSchema = z.object({
    name: z.string(),
    endpoint: z.string().url(),
    protocol: ServiceProtocolSchema,
    region: z.string().optional(),
});
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;
