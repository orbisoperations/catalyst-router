import { z } from 'zod'

import { NodeConfigSchema, PortEntrySchema } from '@catalyst/config'

export const OrchestratorConfigSchema = z.object({
  node: NodeConfigSchema.extend({
    endpoint: z.string(), // Orchestrator requires an endpoint for its own node
  }),
  gqlGatewayConfig: z
    .object({
      endpoint: z.string(),
    })
    .optional(),
  envoyConfig: z
    .object({
      endpoint: z.string(),
      envoyAddress: z.string().optional(),
      portRange: z.array(PortEntrySchema).min(1),
    })
    .optional(),
})

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>
