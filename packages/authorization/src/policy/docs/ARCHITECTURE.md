# Architecture

This document describes the decoupled architecture of the Authorization Engine.

## Core Concepts

### EntityBuilder

The `EntityBuilder` is the core class for constructing Cedar entities. It uses a **Composite Pattern** to allow plugging in arbitrary models without modifying the builder itself.

- **Fluent API**: Supports chaining methods (e.g., `.entity().setAttributes()`).
- **Composite Support**: The `.add(component: EntityProvider)` method allows integrating domain-specific logic.

### EntityProvider

The `EntityProvider` interface defines the contract for any object that can generate entities:

```typescript
export interface EntityProvider {
  build(): Entity[]
}
```

Any class implementing this can be added to the `EntityBuilder`.

### EntityCollection

`EntityCollection` wraps the raw array of `Entity` objects returned by the builder. It provides helper methods to easily reference entities during authorization checks, reducing boilerplate and potential for ID typos.

```typescript
const entities = builder.build() // Returns EntityCollection
const userRef = entities.entityRef('User', 'alice')
```

## The Authorization Engine

The `AuthorizationEngine` is the main entry point. It wraps the Cedar Wasm engine and provides a type-safe interface for your application.

### Initialization

```typescript
const engine = new AuthorizationEngine<MyDomain>(schema, policies)
```

### Policy Validation

The engine provides a `validatePolicies()` method to ensure your policies match your schema.

```typescript
try {
  engine.validatePolicies() // Throws if validation fails
} catch (error) {
  console.error('Invalid policies:', error)
}
```

This checks for syntax errors, schema mismatch, and type errors in your policies.

### Authorization Checks

The `isAuthorized` method performs the actual access control check.

```typescript
const result = engine.isAuthorized({
  principal: entities.entityRef('User', 'alice'),
  action: { type: 'Action', id: 'view' },
  resource: entities.entityRef('Document', 'doc1'),
  entities: entities, // Pass the collection directly
  context: { ... } // Optional context
});
```

## Generic Model Integration (`GenericZodModel`)

To support model-agnostic integration with other parts of the system (like `orchestrator` or `auth` packages), we provide a `GenericZodModel` adapter.

This adapter allows you to take an existing **Zod Schema** and a data object, and automatically transform it into a Cedar entity.

### Usage Example

```typescript
import { z } from 'zod'
import { GenericZodModel } from './models/GenericZodModel'

// External Schema (e.g. from another package)
const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
})

// Create model adapter
const userModel = new GenericZodModel(
  'User', // Cedar Entity Type
  UserSchema, // Zod Schema for validation
  userData, // Raw data
  'id' // Field to use as Entity ID
)

// Add to builder
builder.add(userModel)
```

## Strong Typing and Domain Definitions

The engine supports strong static typing for Action IDs and Entity Types/References. This is achieved by defining an `AuthorizationDomain`.

### Defining a Domain

You define a domain as an array of namespace configurations. This supports splitting definitions across files or namespaces, similar to Cedar schemas.

```typescript
import { AuthorizationDomain } from '@catalyst/authorization'

type MyDomain = [
  {
    Namespace: 'MyApp'
    Actions: 'view' | 'edit' | 'delete'
    Entities: {
      User: { name: string; role: string }
      Document: { owner: string }
    }
  },
]
```

### Using Strongly Typed Engine

When you initialize the engine or collection with this domain, TypeScript will enforce validity:

```typescript
const engine = new AuthorizationEngine<MyDomain>(schema, policies)
const entities = new EntityBuilder<MyDomain>().build()

engine.isAuthorized({
  action: 'MyApp::Action::view', // Strongly typed string
  principal: entities.entityRef('User', 'alice'),
  resource: entities.entityRef('Document', 'doc1'),
  entities: entities, // Pass entity list
})
```

## Decoupling Strategy

1. **No Hard Dependencies**: The Authorization Engine does not import types or schemas from `auth` or `orchestrator` packages directly.
2. **Schema Adaptation**: Applications using this engine are responsible for providing the Zod schemas and data. The engine simply validates and maps them.
3. **Flexible Attributes**: The `GenericZodModel` maps all schema fields (except the ID field) to Cedar attributes. Complex types like `Date` are converted to strings to be compatible with Cedar.

This design allows the Authorization Engine to evolve independently of the domain models it authorizes.
