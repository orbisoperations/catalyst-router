import { z } from 'zod'

/**
 * BootstrapState model - singleton tracking one-time bootstrap token state
 *
 * Used to create the first admin user. Once used, cannot be reused.
 */
export const BootstrapStateSchema = z.object({
  tokenHash: z.string().min(1),
  expiresAt: z.date(),
  used: z.boolean().default(false),
  createdAdminId: z.string().startsWith('usr_').optional(),
})

export type BootstrapState = z.infer<typeof BootstrapStateSchema>
