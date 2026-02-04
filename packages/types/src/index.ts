import { z } from 'zod'

/**
 * Generic success/error result schema with data
 *
 * Use for operations that return data on success.
 *
 * @example
 * ```typescript
 * const UserResultSchema = createResultSchema(UserSchema)
 * type UserResult = z.infer<typeof UserResultSchema>
 *
 * function getUser(id: string): UserResult {
 *   if (userExists(id)) {
 *     return { success: true, data: user }
 *   }
 *   return { success: false, error: 'User not found' }
 * }
 * ```
 */
export function createResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),
      data: dataSchema,
    }),
    z.object({
      success: z.literal(false),
      error: z.string(),
    }),
  ])
}

/**
 * Generic result type inferred from createResultSchema
 */
export type Result<T> = { success: true; data: T } | { success: false; error: string }

/**
 * Generic success/error result schema with optional data
 *
 * Use for operations that may not return data on success (e.g., delete, update).
 *
 * @example
 * ```typescript
 * const DeleteResultSchema = createOptionalResultSchema(z.void())
 * type DeleteResult = z.infer<typeof DeleteResultSchema>
 *
 * function deleteUser(id: string): DeleteResult {
 *   if (deleted) {
 *     return { success: true }
 *   }
 *   return { success: false, error: 'User not found' }
 * }
 * ```
 */
export function createOptionalResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),
      data: dataSchema.optional(),
    }),
    z.object({
      success: z.literal(false),
      error: z.string(),
    }),
  ])
}

/**
 * Generic optional result type inferred from createOptionalResultSchema
 */
export type OptionalResult<T> = { success: true; data?: T } | { success: false; error: string }

/**
 * Generic validation result schema
 *
 * Use for validation operations (e.g., JWT verification, schema validation).
 * Uses 'valid' as discriminator instead of 'success' for semantic clarity.
 *
 * @example
 * ```typescript
 * const TokenValidationSchema = createValidationResultSchema(
 *   z.record(z.string(), z.unknown())
 * )
 * type TokenValidation = z.infer<typeof TokenValidationSchema>
 *
 * function verifyToken(token: string): TokenValidation {
 *   if (isValid(token)) {
 *     return { valid: true, payload: decoded }
 *   }
 *   return { valid: false, error: 'Invalid token' }
 * }
 * ```
 */
export function createValidationResultSchema<T extends z.ZodType>(payloadSchema: T) {
  return z.discriminatedUnion('valid', [
    z.object({
      valid: z.literal(true),
      payload: payloadSchema,
    }),
    z.object({
      valid: z.literal(false),
      error: z.string(),
    }),
  ])
}

/**
 * Generic validation result type inferred from createValidationResultSchema
 */
export type ValidationResult<T> = { valid: true; payload: T } | { valid: false; error: string }
