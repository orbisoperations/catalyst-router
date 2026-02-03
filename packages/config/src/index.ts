import { z } from 'zod'

/**
 * Shared Node Identity Schema
 */
export const NodeConfigSchema = z.object({
  name: z.string(),
  domains: z.array(z.string()),
  endpoint: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
})

export type NodeConfig = z.infer<typeof NodeConfigSchema>

/**
 * Orchestrator Specific Configuration
 */
export const OrchestratorConfigSchema = z.object({
  ibgp: z
    .object({
      secret: z.string().optional(),
    })
    .optional(),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>

/**
 * Top-level Catalyst System Configuration
 */
export const CatalystConfigSchema = z.object({
  node: NodeConfigSchema,
  orchestrator: OrchestratorConfigSchema.optional(),
})

export type CatalystConfig = z.infer<typeof CatalystConfigSchema>
