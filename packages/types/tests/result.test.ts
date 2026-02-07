import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  createResultSchema,
  createOptionalResultSchema,
  createValidationResultSchema,
  type Result,
  type OptionalResult,
  type ValidationResult,
} from '../src/index.js'

describe('Result types', () => {
  describe('createResultSchema', () => {
    const UserSchema = z.object({
      id: z.string(),
      name: z.string(),
    })
    const UserResultSchema = createResultSchema(UserSchema)
    type UserResult = z.infer<typeof UserResultSchema>

    test('validates success case with data', () => {
      const result: UserResult = {
        success: true,
        data: { id: '123', name: 'Alice' },
      }
      expect(UserResultSchema.safeParse(result).success).toBe(true)
    })

    test('validates failure case with error', () => {
      const result: UserResult = {
        success: false,
        error: 'User not found',
      }
      expect(UserResultSchema.safeParse(result).success).toBe(true)
    })

    test('rejects success without data', () => {
      const result = {
        success: true,
      }
      expect(UserResultSchema.safeParse(result).success).toBe(false)
    })

    test('rejects failure without error', () => {
      const result = {
        success: false,
      }
      expect(UserResultSchema.safeParse(result).success).toBe(false)
    })

    test('type compatibility with Result<T>', () => {
      const result: Result<{ id: string; name: string }> = {
        success: true,
        data: { id: '123', name: 'Alice' },
      }
      expect(result.success).toBe(true)
    })
  })

  describe('createOptionalResultSchema', () => {
    const DeleteResultSchema = createOptionalResultSchema(z.void())
    type DeleteResult = z.infer<typeof DeleteResultSchema>

    test('validates success without data', () => {
      const result: DeleteResult = {
        success: true,
      }
      expect(DeleteResultSchema.safeParse(result).success).toBe(true)
    })

    test('validates success with optional data', () => {
      const result: DeleteResult = {
        success: true,
        data: undefined,
      }
      expect(DeleteResultSchema.safeParse(result).success).toBe(true)
    })

    test('validates failure with error', () => {
      const result: DeleteResult = {
        success: false,
        error: 'Delete failed',
      }
      expect(DeleteResultSchema.safeParse(result).success).toBe(true)
    })

    test('type compatibility with OptionalResult<T>', () => {
      const result: OptionalResult<void> = {
        success: true,
      }
      expect(result.success).toBe(true)
    })
  })

  describe('type narrowing', () => {
    test('narrows Result<T> by success discriminator', () => {
      const UserSchema = z.object({ id: z.string() })
      const _UserResultSchema = createResultSchema(UserSchema)
      type UserResult = z.infer<typeof _UserResultSchema>

      // Simulate a function that returns a result
      const getResult = (success: boolean): UserResult => {
        if (success) {
          return { success: true, data: { id: '123' } }
        }
        return { success: false, error: 'Not found' }
      }

      const successResult = getResult(true)
      if (successResult.success) {
        // TypeScript should know result.data exists here
        expect(successResult.data.id).toBe('123')
      } else {
        // TypeScript should know result.error exists here
        expect(successResult.error).toBeDefined()
      }

      const failureResult = getResult(false)
      if (failureResult.success) {
        expect(failureResult.data.id).toBeDefined()
      } else {
        expect(failureResult.error).toBe('Not found')
      }
    })

    test('narrows OptionalResult<T> by success discriminator', () => {
      const _DeleteResultSchema = createOptionalResultSchema(z.void())
      type DeleteResult = z.infer<typeof _DeleteResultSchema>

      // Simulate a function that returns a result
      const deleteUser = (exists: boolean): DeleteResult => {
        if (exists) {
          return { success: true }
        }
        return { success: false, error: 'Not found' }
      }

      const successResult = deleteUser(true)
      if (successResult.success) {
        // TypeScript should allow accessing optional data
        expect(successResult.data).toBeUndefined()
      } else {
        expect(successResult.error).toBeDefined()
      }

      const failureResult = deleteUser(false)
      if (failureResult.success) {
        expect(failureResult.data).toBeUndefined()
      } else {
        expect(failureResult.error).toBe('Not found')
      }
    })
  })

  describe('createValidationResultSchema', () => {
    const PayloadSchema = z.record(z.string(), z.unknown())
    const ValidationSchema = createValidationResultSchema(PayloadSchema)
    type Validation = z.infer<typeof ValidationSchema>

    test('validates valid case with payload', () => {
      const result: Validation = {
        valid: true,
        payload: { sub: 'user-123', role: 'admin' },
      }
      expect(ValidationSchema.safeParse(result).success).toBe(true)
    })

    test('validates invalid case with error', () => {
      const result: Validation = {
        valid: false,
        error: 'Token expired',
      }
      expect(ValidationSchema.safeParse(result).success).toBe(true)
    })

    test('rejects valid without payload', () => {
      const result = {
        valid: true,
      }
      expect(ValidationSchema.safeParse(result).success).toBe(false)
    })

    test('rejects invalid without error', () => {
      const result = {
        valid: false,
      }
      expect(ValidationSchema.safeParse(result).success).toBe(false)
    })

    test('type compatibility with ValidationResult<T>', () => {
      const result: ValidationResult<Record<string, unknown>> = {
        valid: true,
        payload: { sub: 'user-123' },
      }
      expect(result.valid).toBe(true)
    })

    test('narrows ValidationResult by valid discriminator', () => {
      const TokenSchema = z.object({ sub: z.string(), exp: z.number() })
      const _TokenValidationSchema = createValidationResultSchema(TokenSchema)
      type TokenValidation = z.infer<typeof _TokenValidationSchema>

      // Simulate a function that returns a validation result
      const verifyToken = (isValid: boolean): TokenValidation => {
        if (isValid) {
          return { valid: true, payload: { sub: 'user-123', exp: Date.now() } }
        }
        return { valid: false, error: 'Invalid signature' }
      }

      const validResult = verifyToken(true)
      if (validResult.valid) {
        // TypeScript should know payload exists here
        expect(validResult.payload.sub).toBe('user-123')
      } else {
        expect(validResult.error).toBeDefined()
      }

      const invalidResult = verifyToken(false)
      if (invalidResult.valid) {
        expect(invalidResult.payload).toBeDefined()
      } else {
        expect(invalidResult.error).toBe('Invalid signature')
      }
    })
  })
})
