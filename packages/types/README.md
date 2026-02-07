# @catalyst/types

Shared type definitions and schemas for Catalyst Node.

## Overview

This package provides common type patterns used across the Catalyst codebase, with a focus on discriminated unions for result types. All types are backed by Zod schemas for runtime validation.

## Result Types

### `ValidationResult<T>`

Generic validation result type using 'valid' discriminator.

**Schema:** `createValidationResultSchema(payloadSchema)`

**Use for:** Validation operations (JWT verification, schema validation, input validation)

**Why 'valid' instead of 'success'?** Semantically clearer for validation contexts. When you verify a token, you check if it's "valid" or "invalid", not if the operation "succeeded" or "failed".

```typescript
import { createValidationResultSchema, type ValidationResult } from '@catalyst/types'
import { z } from 'zod'

// Define your payload schema
const TokenPayloadSchema = z.record(z.string(), z.unknown())

// Create validation schema
const TokenValidationSchema = createValidationResultSchema(TokenPayloadSchema)
type TokenValidation = z.infer<typeof TokenValidationSchema>

// Use in functions
function verifyToken(token: string): TokenValidation {
  try {
    const payload = decodeAndValidate(token)
    return { valid: true, payload }
  } catch (error) {
    return { valid: false, error: 'Invalid token signature' }
  }
}

// Type narrowing works automatically
const result = verifyToken(userToken)
if (result.valid) {
  console.log(result.payload.sub) // TypeScript knows payload exists
} else {
  console.error(result.error) // TypeScript knows error exists
}
```

**Test Helper Pattern:**

```typescript
function expectValid(result: ValidationResult<Record<string, unknown>>) {
  expect(result.valid).toBe(true)
  return (result as { valid: true; payload: Record<string, unknown> }).payload
}

function expectInvalid(result: ValidationResult<Record<string, unknown>>) {
  expect(result.valid).toBe(false)
  return (result as { valid: false; error: string }).error
}
```

### `Result<T>`

Generic success/error result type with required data on success.

**Schema:** `createResultSchema(dataSchema)`

**Use for:** Operations that return data on success (e.g., fetch, create, get)

```typescript
import { createResultSchema } from '@catalyst/types'
import { z } from 'zod'

// Define your data schema
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
})

// Create result schema
const UserResultSchema = createResultSchema(UserSchema)
type UserResult = z.infer<typeof UserResultSchema>

// Use in functions
function getUser(id: string): UserResult {
  const user = db.findUser(id)
  if (user) {
    return { success: true, data: user }
  }
  return { success: false, error: 'User not found' }
}

// Type narrowing works automatically
const result = getUser('123')
if (result.success) {
  console.log(result.data.name) // TypeScript knows data exists
} else {
  console.error(result.error) // TypeScript knows error exists
}
```

### `OptionalResult<T>`

Generic success/error result type with optional data on success.

**Schema:** `createOptionalResultSchema(dataSchema)`

**Use for:** Operations that may not return data (e.g., delete, update, void operations)

```typescript
import { createOptionalResultSchema } from '@catalyst/types'
import { z } from 'zod'

// Create result schema for operation with no return value
const DeleteResultSchema = createOptionalResultSchema(z.void())
type DeleteResult = z.infer<typeof DeleteResultSchema>

// Use in functions
function deleteUser(id: string): DeleteResult {
  const deleted = db.deleteUser(id)
  if (deleted) {
    return { success: true }
  }
  return { success: false, error: 'User not found' }
}

// Type narrowing works
const result = deleteUser('123')
if (result.success) {
  console.log('Deleted successfully')
} else {
  console.error(result.error)
}
```

## Pattern Advantages

1. **Type Safety:** Discriminated unions provide exhaustive type checking
2. **Runtime Validation:** Zod schemas validate data at runtime
3. **Consistent API:** All result types follow the same pattern
4. **Error Handling:** Explicit success/failure paths with error messages
5. **Type Narrowing:** TypeScript automatically narrows types based on discriminator field
6. **Semantic Clarity:** Use `valid` for validation, `success` for operations

## Migration Guide

### Before (ad-hoc types)

```typescript
// Multiple inconsistent patterns across codebase
type SignResult = { success: true; token: string } | { success: false; error: string }
type VerifyResult = { valid: true; payload: any } | { valid: false; error: string }
type CliResult<T> = { success: true; data?: T } | { success: false; error: string }
```

### After (standardized)

```typescript
import {
  createResultSchema,
  createOptionalResultSchema,
  createValidationResultSchema,
  type ValidationResult,
} from '@catalyst/types'

// Operations that return data
const SignResultSchema = createResultSchema(z.object({ token: z.string() }))

// Operations without return data
const DeleteResultSchema = createOptionalResultSchema(z.void())

// Validation operations
const VerifyResultSchema = createValidationResultSchema(z.record(z.string(), z.unknown()))
// Or use the type directly
type VerifyResult = ValidationResult<Record<string, unknown>>
```

## Design Decisions

- **Zod-first:** All types are inferred from Zod schemas for runtime safety
- **Discriminated unions:** Use `success` or `valid` as discriminator for type narrowing
- **Semantic discriminators:** `valid` for validation, `success` for operations
- **String errors:** Default error type is `string` for simplicity (can be extended)
- **Three variants:**
  - `Result<T>` - required data on success
  - `OptionalResult<T>` - optional data on success
  - `ValidationResult<T>` - validation with payload on valid

## See Also

- [Discriminated Unions in TypeScript](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)
- [Zod Documentation](https://zod.dev/)
