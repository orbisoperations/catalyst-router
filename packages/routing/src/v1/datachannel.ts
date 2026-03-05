import { z } from 'zod'
// Local re-definition to decouple from V1
export const DataChannelProtocolEnum = z.enum([
  'http',
  'http:graphql',
  'http:gql',
  'http:grpc',
  'tcp',
] as const)
export type DataChannelProtocol = z.infer<typeof DataChannelProtocolEnum>

export const DataChannelDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i),
  endpoint: z.url().optional(),
  protocol: DataChannelProtocolEnum,
  region: z.string().optional(),
  tags: z.array(z.string()).optional(),
  envoyPort: z.number().int().optional(),
})
export type DataChannelDefinition = z.infer<typeof DataChannelDefinitionSchema>
