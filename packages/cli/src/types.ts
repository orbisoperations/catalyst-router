import { ServiceDefinitionSchema } from '@catalyst/orchestrator'
import { z } from 'zod'

export type CliResult<T> = { success: true; data?: T } | { success: false; error: string }

export const BaseCliConfigSchema = z.object({
  orchestratorUrl: z
    .string()
    .url()
    .default(process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})
export type BaseCliConfig = z.infer<typeof BaseCliConfigSchema>

export const AddServiceInputSchema = ServiceDefinitionSchema.pick({
  name: true,
  endpoint: true,
  protocol: true,
}).merge(BaseCliConfigSchema)

export type AddServiceInput = z.infer<typeof AddServiceInputSchema>

export const ListServicesInputSchema = BaseCliConfigSchema
export type ListServicesInput = z.infer<typeof ListServicesInputSchema>

// Node Peer Schemas
export const CreatePeerInputSchema = BaseCliConfigSchema.extend({
  name: z.string().min(1),
  endpoint: z.string().url(),
  domains: z.array(z.string()).default([]),
  peerToken: z.string().optional(),
  token: z.string().optional(),
})
export type CreatePeerInput = z.infer<typeof CreatePeerInputSchema>

export const DeletePeerInputSchema = BaseCliConfigSchema.extend({
  name: z.string().min(1),
  token: z.string().optional(),
})
export type DeletePeerInput = z.infer<typeof DeletePeerInputSchema>

export const ListPeersInputSchema = BaseCliConfigSchema.extend({
  token: z.string().optional(),
})
export type ListPeersInput = z.infer<typeof ListPeersInputSchema>

// Node Route Schemas
export const CreateRouteInputSchema = BaseCliConfigSchema.extend({
  name: z.string().min(1),
  endpoint: z.string().url(),
  protocol: z.enum(['http', 'http:graphql', 'http:gql', 'http:grpc']).default('http:graphql'),
  region: z.string().optional(),
  tags: z.array(z.string()).optional(),
  token: z.string().optional(),
})
export type CreateRouteInput = z.infer<typeof CreateRouteInputSchema>

export const DeleteRouteInputSchema = BaseCliConfigSchema.extend({
  name: z.string().min(1),
  token: z.string().optional(),
})
export type DeleteRouteInput = z.infer<typeof DeleteRouteInputSchema>

export const ListRoutesInputSchema = BaseCliConfigSchema.extend({
  token: z.string().optional(),
})
export type ListRoutesInput = z.infer<typeof ListRoutesInputSchema>
