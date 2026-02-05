import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { AuthorizationEngine } from '../../../src/policy/src/authorization-engine.js'
import { EntityBuilder, EntityBuilderFactory } from '../../../src/policy/src/entity-builder.js'
import { EntityCollection } from '../../../src/policy/src/entity-collection.js'
import { GenericZodModel } from '../../../src/policy/src/providers/GenericZodModel.js'

describe('Strongly Typed Authorization Engine', () => {
  // 1. Define Domain Types
  // This is typically what a user would define in their application code
  type MyAppDomain = [
    {
      Namespace: 'App'
      Actions: 'view' | 'edit' | 'delete'
      Entities: {
        User: {
          name: string
          role: string
        }
        Document: {
          owner: string
          public: boolean
        }
      }
    },
  ]

  // 2. Define Schemas (can be reused from Domain definition or separate)
  const UserSchema = z.object({
    name: z.string(),
    role: z.string(),
  })

  const DocumentSchema = z.object({
    owner: z.string(),
    public: z.boolean(),
  })

  it('should create an EntityBuilderFactory', () => {
    const builderFactory = new EntityBuilderFactory<MyAppDomain>()
    expect(builderFactory).toBeDefined()
    expect(builderFactory.createEntityBuilder()).toBeDefined()

    // the factory should return an EntityBuilder
    const builder = builderFactory.createEntityBuilder()
    expect(builder).toBeDefined()
    expect(builder.build()).toBeDefined()

    // check the type of the builder
    expect(builder).toBeInstanceOf(EntityBuilder<MyAppDomain>)

    // check the type of the builder's build method
    const entities = builder
      .add(new GenericZodModel('App::User', UserSchema, { name: 'Alice', role: 'admin' }, 'name'))
      .build()
    expect(entities).toBeDefined()
    expect(entities).toBeInstanceOf(EntityCollection<MyAppDomain>)

    // showing typesafety
    entities.entityRef('App::User', 'Alice')
    entities.entityRef('App::Document', 'documentId')
  })

  it('should enforce static typing on authorization requests', () => {
    // Setup Engine with Domain Type
    const engine = new AuthorizationEngine<MyAppDomain>(
      'namespace App { entity User; entity Document; action view, edit, delete; }',
      'permit(principal, action, resource);'
    )

    const entities = new EntityBuilderFactory<MyAppDomain>()
      .createEntityBuilder()
      .add(new GenericZodModel('App::User', UserSchema, { name: 'Alice', role: 'admin' }, 'name'))
      .add(
        new GenericZodModel(
          'App::Document',
          DocumentSchema,
          { owner: 'Alice', public: true },
          'owner'
        )
      )
      .build()

    // Construct Typed Request
    const request = {
      principal: entities.entityRef('App::User', 'Alice'),
      action: 'App::Action::view' as const, // Must match 'view' | 'edit' | 'delete'
      resource: entities.entityRef('App::Document', 'Alice'),
      context: {},
      entities: entities.getAll(),
    }

    const result = engine.isAuthorized(request)
    expect(result).toBeDefined()
  })

  // This test block demonstrates type safety. usage of @ts-expect-error proves
  // that TypeScript would block these invalid usages during compilation.
  it('should prevent invalid actions and entity types (Type Check Demo)', () => {
    const engine = new AuthorizationEngine<MyAppDomain>('', '')
    const entities = new EntityBuilderFactory<MyAppDomain>().createEntityBuilder().build()

    // Case 1: invalid action ID 'destroy' (only 'view'|'edit'|'delete' allowed)
    engine.isAuthorized({
      principal: entities.entityRef('App::User', 'Alice'),
      // @ts-expect-error - 'destroy' is not assignable to type
      action: 'App::Action::destroy',
      resource: entities.entityRef('App::Document', 'doc1'),
      entities: [],
      context: {},
    })

    // Case 2: Invalid Entity Type 'Project' (not in MyAppDomain)
    // @ts-expect-error - Argument of type '"Project"' is not assignable to parameter of type '"App::User" | "App::Document"'
    entities.entityRef('Project', '123')

    // Case 3: Manually constructed invalid entity entityReference in request
    engine.isAuthorized({
      // @ts-expect-error - Type '"Project"' is not assignable to type '"App::User" | "App::Document"'
      principal: { type: 'Project', id: '123' },
      action: 'App::Action::view',
      resource: entities.entityRef('App::Document', 'doc1'),
      entities: [],
      context: {},
    })

    expect(true).toBe(true)
  })
})
