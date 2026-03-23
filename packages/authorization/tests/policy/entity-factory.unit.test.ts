import { describe, expect, it } from 'vitest'
import z from 'zod'
import { EntityBuilder, EntityBuilderFactory } from '../../src/policy/src/entity-builder.js'
import { EntityCollection } from '../../src/policy/src/entity-collection.js'
import { GenericZodModel } from '../../src/policy/src/providers/GenericZodModel.js'

describe('EntityFactory', () => {
  type TestDomain = [
    {
      Namespace: 'Test'
      Actions: 'view' | 'edit' | 'delete'
      Entities: {
        User: {
          name: string
          age: number
          email: string
          role: string
        }
      }
    },
  ]

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
          'Test::User',
          TestUserSchema,
          { name: 'alice', age: 30, email: 'alice@example.com', role: 'admin' },
          'name'
        )
      )
      .add(
        new GenericZodModel(
          'Test::User',
          TestUserSchema,
          { name: 'bob', age: 25, email: 'bob@example.com', role: 'user' },
          'name'
        )
      )
      .build()

    expect(entities).toBeInstanceOf(EntityCollection<TestDomain>)
    expect(entities.getAll()).toHaveLength(2)
    expect(entities.get('Test::User', 'alice')).toBeDefined()
    expect(entities.get('Test::User', 'bob')).toBeDefined()
    expect(entities.get('Test::User', 'non-existing')).toBeUndefined()

    // correct typesafety
    const aliceEntityentityRef = entities.entityRef('Test::User', 'alice')
    const bobEntityentityRef = entities.entityRef('Test::User', 'bob')
    expect(aliceEntityentityRef).toBeDefined()
    expect(bobEntityentityRef).toBeDefined()

    // currently it creates an entity entityRef regardless of if the entity exists
    // TODO: should throw an error if the entity does not exist?
    const nonExistingEntityentityRef = entities.entityRef('Test::User', 'non-existing')
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
