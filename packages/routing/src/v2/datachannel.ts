import { z } from 'zod'

export const DataChannelProtocolEnum = z.enum([
  'http',
  'http:graphql',
  'http:gql',
  'http:grpc',
  'tcp',
] as const)
export type DataChannelProtocol = z.infer<typeof DataChannelProtocolEnum>

/** Maximum number of tags on a data channel definition. */
export const MAX_TAGS_PER_CHANNEL = 32
/** Maximum length of an endpoint URL string. */
export const MAX_ENDPOINT_LENGTH = 2048

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
})
export type DataChannelDefinition = z.infer<typeof DataChannelDefinitionSchema>

/** Route identity key. Currently name-only; future: compound (name, protocol). */
export function routeKey(route: Pick<DataChannelDefinition, 'name'>): string {
  return route.name
}
