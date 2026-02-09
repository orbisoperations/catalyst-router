import { DataChannelDefinitionSchema } from '@catalyst/routing'
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

export const AddServiceInputSchema = DataChannelDefinitionSchema.pick({
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

// Auth Token Schemas
export const MintTokenInputSchema = z.object({
  subject: z.string().min(1),
  role: z.enum(['ADMIN', 'NODE', 'NODE_CUSTODIAN', 'DATA_CUSTODIAN', 'USER']),
  name: z.string().min(1),
  type: z.enum(['user', 'service']).default('user'),
  expiresIn: z.string().optional(),
  nodeId: z.string().optional(),
  trustedDomains: z.array(z.string()).optional(),
  trustedNodes: z.array(z.string()).optional(),
  authUrl: z.string().url().optional(),
  token: z.string().optional(),
})
export type MintTokenInput = z.infer<typeof MintTokenInputSchema>

export const VerifyTokenInputSchema = z.object({
  tokenToVerify: z.string().min(1),
  audience: z.string().optional(),
  authUrl: z.string().url().optional(),
  token: z.string().optional(),
})
export type VerifyTokenInput = z.infer<typeof VerifyTokenInputSchema>

export const RevokeTokenInputSchema = z
  .object({
    jti: z.string().optional(),
    san: z.string().optional(),
    authUrl: z.string().url().optional(),
    token: z.string().optional(),
  })
  .refine((data) => data.jti || data.san, {
    message: 'Either jti or san must be provided',
  })
export type RevokeTokenInput = z.infer<typeof RevokeTokenInputSchema>

export const ListTokensInputSchema = z.object({
  certificateFingerprint: z.string().optional(),
  san: z.string().optional(),
  authUrl: z.string().url().optional(),
  token: z.string().optional(),
})
export type ListTokensInput = z.infer<typeof ListTokensInputSchema>
