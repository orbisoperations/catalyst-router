import { z } from 'zod'

/**
 * User model - represents a human user of the system
 *
 * POC Note: Only "admin" role supported. status field omitted (all users active).
 */
export const UserSchema = z.object({
  id: z.string().startsWith('usr_'),
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase()),
  passwordHash: z.string().min(1),
  roles: z.array(z.string()).min(1),
  orgId: z.string().default('default'),
  createdAt: z.date(),
  lastLoginAt: z.date().optional(),
})

export type User = z.infer<typeof UserSchema>

/**
 * Input for creating a new user (id and createdAt generated)
 */
export type CreateUserInput = Omit<User, 'id' | 'createdAt'>

/**
 * Generate a user ID
 */
export function generateUserId(): string {
  return `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
