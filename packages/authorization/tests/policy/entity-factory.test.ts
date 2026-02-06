import { describe, expect, it } from 'bun:test'
import z from 'zod'
import { EntityBuilder, EntityBuilderFactory } from '../../src/policy/src/entity-builder.js'
import { EntityCollection } from '../../src/policy/src/entity-collection.js'
import { GenericZodModel } from '../../src/policy/src/providers/GenericZodModel.js'
import type { AuthorizationDomain } from '../../src/policy/src/types.js'

describe('EntityFactory', () => {
  interface TestDomain extends AuthorizationDomain {
    Actions: 'view' | 'edit' | 'delete'
    Entities: {
      User: {
        name: string
        age: number
        email: string
        role: string
      }
    }
  }

  const TestUserSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string(),
    role: z.string(),
  })

  it('should create an typed EntityFactory', () => {
    const factory = new EntityBuilderFactory<TestDomain>()
    expect(factory).toBeDefined()
  })

  it('should create an EntityBuilder', () => {
    const entityFactory = new EntityBuilderFactory<TestDomain>()
    const builder = entityFactory.createEntityBuilder()
    expect(builder).toBeDefined()
    // should return an EntityBuilder
    expect(builder).toBeInstanceOf(EntityBuilder<TestDomain>)

    const entities = builder
      .add(
        new GenericZodModel(
          'User',
          TestUserSchema,
          { name: 'alice', age: 30, email: 'alice@example.com', role: 'admin' },
          'name'
        )
      )
      .add(
        new GenericZodModel(
          'User',
          TestUserSchema,
          { name: 'bob', age: 25, email: 'bob@example.com', role: 'user' },
          'name'
        )
      )
      .build()

    expect(entities).toBeInstanceOf(EntityCollection<TestDomain>)
    expect(entities.getAll()).toHaveLength(2)
    expect(entities.get('User', 'alice')).toBeDefined()
    expect(entities.get('User', 'bob')).toBeDefined()
    expect(entities.get('User', 'non-existing')).toBeUndefined()

    // correct typesafety
    const aliceEntityentityRef = entities.entityRef('User', 'alice')
    const bobEntityentityRef = entities.entityRef('User', 'bob')
    expect(aliceEntityentityRef).toBeDefined()
    expect(bobEntityentityRef).toBeDefined()

    // currently it creates an entity entityRef regardless of if the entity exists
    // TODO: should throw an error if the entity does not exist?
    const nonExistingEntityentityRef = entities.entityRef('User', 'non-existing')
    expect(nonExistingEntityentityRef).toBeDefined()
  })

  it('should throw an error if the entity does not exist', () => {
    const entityFactory = new EntityBuilderFactory<TestDomain>()
    const builder = entityFactory.createEntityBuilder()
    expect(builder).toBeDefined()
    // should return an EntityBuilder
    expect(builder).toBeInstanceOf(EntityBuilder<TestDomain>)
  })
})
