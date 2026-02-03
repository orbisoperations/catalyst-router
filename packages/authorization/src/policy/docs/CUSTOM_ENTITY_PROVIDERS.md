# Zod Integration Guide

The Authorization Engine provides seamless integration with Zod for type-safe entity creation. This guide explains the two primary ways to create entities from Zod schemas: using `GenericZodModel` (Deprecated) and the newer `builder.addFromZod()` method.

## 1. Using `builder.addFromZod()` (Recommended)

The recommended approach is to use the `addFromZod` method directly on the `EntityBuilder`. This provides a fluent API and avoids the overhead of creating intermediate model instances.

### Usage

```typescript
import { z } from 'zod'
import { EntityBuilderFactory } from '@catalyst-node/authorization-engine'

// Define your Zod schema
const UserSchema = z.object({
  username: z.string(),
  role: z.string(),
  email: z.string().email(),
})

// Create builder
const factory = new EntityBuilderFactory()
const builder = factory.createEntityBuilder()

// Add entity from Zod data
builder.addFromZod(
  'User', // Entity Type
  UserSchema, // Zod Schema
  {
    // Data
    username: 'alice',
    role: 'admin',
    email: 'alice@example.com',
  },
  { idField: 'username' } // Config: which field is the ID
)
```

### Chaining Parents

You can easily chain parent relationships:

```typescript
builder.addFromZod('TodoList', ListSchema, listData, { idField: 'id' }).addParent('User', 'alice')
```

## 2. Using Factory Mappers (High Performance)

For high-throughput scenarios where Zod validation overhead is a concern, you can register custom mappers at the factory level. This bypasses Zod validation during the build phase.

### Mapper Usage

```typescript
// 1. Register Mapper
factory.registerMapper('User', (data: UserType) => ({
  id: data.username,
  attrs: { role: data.role },
  parents: [],
}))

// 2. Use in Builder
const builder = factory.createEntityBuilder()
builder.add('User', { username: 'alice', role: 'admin' })
```

## 3. GenericZodModel (Deprecated)

> **Note**: `GenericZodModel` is deprecated and will be removed in future versions. Please migrate to `addFromZod`.

The legacy approach involved instantiating a `GenericZodModel` class.

```typescript
// Legacy Code
import { GenericZodModel } from '@catalyst-node/authorization-engine'

const userModel = new GenericZodModel('User', UserSchema, data, 'username')
builder.add(userModel)
```

## Performance Comparison

| Method            | Safety                    | Performance             | Use Case                                         |
| ----------------- | ------------------------- | ----------------------- | ------------------------------------------------ |
| `addFromZod`      | High (Runtime Validation) | Medium (Zod Parsing)    | General purpose, API boundaries, untrusted input |
| `Factory Mappers` | Low (Trusts Input)        | High (Direct Mapping)   | Internal loops, trusted data, high throughput    |
| `GenericZodModel` | High                      | Medium (Class overhead) | **Deprecated**                                   |

## 4. EntityProvider Pattern (Advanced)

`GenericZodModel` was an implementation of the `EntityProvider`. This pattern is useful when you need to define custom logic for fetching or building entities, potentially from external sources like a database or API.

You can implement your own `EntityProvider`:

```typescript
import type { EntityProvider, Entity, EntityCollection, DefaultDomain } from '@catalyst-node/authorization-engine'

class DatabaseUserProvider implements EntityProvider<DefaultDomain> {
  constructor(private userId: string) {}

  build(): Entity<DefaultDomain>[] {
    // ... fetch user from DB ...
    return [{
      uid: { type: 'User', id: this.userId },
      attrs: { ... },
      parents: []
    }]
  }
}

// Usage
builder.add(new DatabaseUserProvider('user_123'))
```

## Migration Guide

To migrate from `GenericZodModel` to `addFromZod`:

**Before:**

```typescript
builder.add(new GenericZodModel('User', Schema, data, 'id'))
```

**After:**

```typescript
builder.addFromZod('User', Schema, data, { idField: 'id' })
```
