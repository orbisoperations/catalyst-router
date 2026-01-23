import { z } from 'zod'

/**
 * ServiceAccount model - represents an automated system (CI/CD, etc.)
 *
 * API keys have required expiration (max 1 year from creation).
 */
export const ServiceAccountSchema = z.object({
  id: z.string().startsWith('sa_'),
  name: z.string().min(1).max(100),
  apiKeyHash: z.string().min(1),
  keyPrefix: z.string().regex(/^cat_sk_[a-z0-9]+_$/),
  roles: z.array(z.string()),
  orgId: z.string().default('default'),
  expiresAt: z.date(), // Required, max 1 year (enforced at creation)
  createdAt: z.date(),
  createdBy: z.string().startsWith('usr_'),
})

export type ServiceAccount = z.infer<typeof ServiceAccountSchema>

/**
 * Input for creating a new service account (id and createdAt generated)
 */
export type CreateServiceAccountInput = Omit<ServiceAccount, 'id' | 'createdAt'>

/**
 * Generate a service account ID
 */
export function generateServiceAccountId(): string {
  return `sa_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/**
 * Maximum API key lifetime (1 year in milliseconds)
 */
export const MAX_API_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
