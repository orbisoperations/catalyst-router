import { z } from 'zod'
// Local re-definition to decouple from V1
export const DataChannelProtocolEnum = z.enum([
  'http',
  'http:graphql',
  'http:gql',
  'http:grpc',
] as const)
export type DataChannelProtocol = z.infer<typeof DataChannelProtocolEnum>

export const DataChannelDefinitionSchema = z.object({
  name: z.string(),
  endpoint: z.url().optional(),
  protocol: DataChannelProtocolEnum,
  region: z.string().optional(),
  tags: z.array(z.string()).optional(),
  envoyPort: z.number().int().optional(),
})
export type DataChannelDefinition = z.infer<typeof DataChannelDefinitionSchema>
