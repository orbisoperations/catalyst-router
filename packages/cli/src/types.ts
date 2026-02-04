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
