import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { AuthorizationEngine } from '../../../src/policy/src/authorization-engine.js'
import { EntityBuilderFactory } from '../../../src/policy/src/entity-builder.js'
import { GenericZodModel } from '../../../src/policy/src/providers/GenericZodModel.js'
import type { AuthorizationDomain } from '../../../src/policy/src/types.js'

describe('Full E2E Verification', () => {
  // 1. Define Domain
  interface ECommerceDomain extends AuthorizationDomain {
    Actions: {
      view: Record<string, never>
      buy: {
        trustedNetwork: boolean
      }
      refund: {
        reason: string
      }
    }
    Entities: {
      User: {
        id: string
        role: string
        region: string
      }
      Product: {
        id: string
        category: string
        price: number
      }
      Order: {
        id: string
        ownerId: string
        amount: number
        status: string
      }
    }
  }

  // 2. Define Schemas
  const ProductSchema = z.object({
    id: z.string(),
    category: z.string(),
    price: z.number(),
  })

  // 3. Define Cedar Schema and Policies
  const cedarSchema = `
    entity User {
      id: String,
      role: String,
      region: String
    };
    entity Product {
      category: String,
      price: Long
    };
    entity Order {
      ownerId: String,
      amount: Long,
      status: String
    };

    action view, refund appliesTo {
      principal: [User],
      resource: [Product, Order]
    };

    action buy appliesTo {
      principal: [User],
      resource: [Product],
      context: {
        trustedNetwork: Bool
      }
    };
  `

  const cedarPolicies = `
    // Policy 1: Users can view products
    permit(principal, action == Action::"view", resource is Product);

    // Policy 2: Users can buy products if they are in the same region (Context check)
    // We expect the request context to contain the current location or similar,
    // but here let's say we pass 'trustedNetwork' in context.
    permit(principal, action == Action::"buy", resource is Product)
    when {
      context.trustedNetwork == true
    };

    // Policy 3: Users can view their own orders
    permit(principal, action == Action::"view", resource is Order)
    when {
      resource.ownerId == principal.id
    };
  `

  it('should verify all available functionality', () => {
    // --- Step 1: Instantiate Engine ---
    const engine = new AuthorizationEngine<ECommerceDomain>(cedarSchema, cedarPolicies)
    const isValid = engine.validatePolicies()
    expect(isValid).toBe(false) // Returns true if there are errors/warnings, confusingly named?
    // Wait, let me check validatePolicies implementation again.
    // It returns "hasWarning || hasError || hasOtherWarnings". So false means Good (0 errors).

    // --- Step 2: Instantiate Factory and Register Mappers ---
    const factory = new EntityBuilderFactory<ECommerceDomain>()

    factory.registerMapper('User', (data: { id: string; role: string; region: string }) => ({
      id: data.id,
      attrs: {
        id: data.id, // Explicitly add ID as attribute for policy access
        role: data.role,
        region: data.region,
      },
    }))

    // --- Step 3: Create EntityBuilder ---
    const builder = factory.createEntityBuilder()

    // --- Step 4: Create Entities ---

    // A. Via Mapper
    builder.add('User', { id: 'alice', role: 'customer', region: 'US' })

    // B. Via GenericZodModel
    builder.add(
      new GenericZodModel(
        'Product',
        ProductSchema,
        { id: 'laptop', category: 'electronics', price: 1000 },
        'id'
      )
    )
    // B.1: duplicated entity: to test the addFromZod implementation
    builder.addFromZod(
      'Product',
      ProductSchema,
      { id: 'laptop-2', category: 'electronics', price: 1000 },
      { idField: 'id' }
    )

    // C. Manually
    builder.entity('Order', 'order123').setAttributes({
      ownerId: 'alice',
      amount: 1000,
      status: 'pending',
    })
    // No parent for this simple test, but we could add one
    // .addParent('User', 'alice') // Order is not a child of User in schema, just has ownerId attr

    // --- Step 5: Build Collection ---
    const entities = builder.build()

    // we added
    expect(entities.getAll()).toHaveLength(4)
    expect(entities.get('User', 'alice')).toBeDefined()
    expect(entities.get('Product', 'laptop')).toBeDefined()
    expect(entities.get('Product', 'laptop-2')).toBeDefined()
    expect(entities.get('Order', 'order123')).toBeDefined()

    // --- Step 6: Authorization Checks (including Context) ---

    // Scenario 1: Buy product WITHOUT trustedNetwork context -> DENY
    let result = engine.isAuthorized({
      principal: entities.entityRef('User', 'alice'),
      action: { type: 'Action', id: 'buy' },
      resource: entities.entityRef('Product', 'laptop'),
      entities: entities.getAll(),
      context: {
        trustedNetwork: false,
      },
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('deny')
    }

    // Scenario 2: Buy product WITH trustedNetwork context -> ALLOW
    result = engine.isAuthorized({
      principal: entities.entityRef('User', 'alice'),
      action: { type: 'Action', id: 'buy' },
      resource: entities.entityRef('Product', 'laptop'),
      entities: entities.getAll(),
      context: {
        trustedNetwork: true,
      },
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }

    // Scenario 3: View own order -> ALLOW
    result = engine.isAuthorized({
      principal: entities.entityRef('User', 'alice'),
      action: { type: 'Action', id: 'view' },
      resource: entities.entityRef('Order', 'order123'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type, JSON.stringify(result)).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })
})
