import { z } from 'zod'
import { MAX_TAGS_PER_CHANNEL, MAX_ENDPOINT_LENGTH } from './limits.js'

export { MAX_TAGS_PER_CHANNEL, MAX_ENDPOINT_LENGTH }

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
  endpoint: z.url().max(MAX_ENDPOINT_LENGTH).optional(),
  protocol: DataChannelProtocolEnum,
  region: z.string().optional(),
  tags: z.array(z.string()).max(MAX_TAGS_PER_CHANNEL).optional(),
  envoyPort: z.number().int().optional(),
  envoyAddress: z.string().optional(),
  healthStatus: z.enum(['up', 'down']).optional(),
  responseTimeMs: z.number().nullable().optional(),
  lastChecked: z.string().optional(),
})
export type DataChannelDefinition = z.infer<typeof DataChannelDefinitionSchema>

/** Route identity key. Currently name-only; future: compound (name, protocol). */
export function routeKey(route: Pick<DataChannelDefinition, 'name'>): string {
  return route.name
}
