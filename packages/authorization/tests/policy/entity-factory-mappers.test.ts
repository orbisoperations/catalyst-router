import { describe, expect, it } from 'bun:test'
import { EntityBuilderFactory } from '../../src/policy/src/entity-builder.js'

describe('EntityFactory Mappers', () => {
  // Define Test Domain
  type TestDomain = [
    {
      Namespace: 'Test'
      Actions: 'view' | 'edit'
      Entities: {
        User: {
          username: string
          role: string
        }
        Post: {
          id: string
          authorId: string
          content: string
        }
      }
    },
  ]

  it('should allow registering mappers via the factory', () => {
    const factory = new EntityBuilderFactory<TestDomain>()

    // Test chaining
    const chainedFactory = factory.registerMapper(
      'Test::User',
      (data: { name: string; role: string }) => ({
        id: data.name,
        attrs: { username: data.name, role: data.role },
      })
    )

    expect(chainedFactory).toBe(factory)
    expect(chainedFactory).not.toBe(new EntityBuilderFactory())
  })

  it('should pass registered mappers to the builder', () => {
    const factory = new EntityBuilderFactory<TestDomain>()

    factory.registerMapper('Test::User', (data: { name: string }) => ({
      id: data.name,
      attrs: { username: data.name, role: 'user' },
    }))

    const builder = factory.createEntityBuilder()

    // We can't easily inspect private mappers property, but we can verify behavior
    // by using the builder to add an entity via the mapper
    builder.add('Test::User', { name: 'alice' })
    const entities = builder.build()

    const user = entities.get('Test::User', 'alice')
    expect(user).toBeDefined()
    expect(user?.attrs.username).toBe('alice')
    expect(user?.attrs.role).toBe('user')

    // non exitent user should be undefined
    const nonExistingUser = entities.get('Test::User', 'non-existing')
    expect(nonExistingUser).toBeUndefined()
  })

  it('should correctly execute mappers with parents', () => {
    const factory = new EntityBuilderFactory<TestDomain>()

    factory
      .registerMapper('Test::User', (data: { name: string }) => ({
        id: data.name,
        attrs: { username: data.name, role: 'user' },
      }))
      .registerMapper('Test::Post', (data: { id: string; author: string; text: string }) => ({
        id: data.id,
        attrs: { id: data.id, authorId: data.author, content: data.text },
        parents: [{ type: 'Test::User', id: data.author }],
      }))

    const builder = factory.createEntityBuilder()

    builder.add('Test::User', { name: 'bob' })
    builder.add('Test::Post', { id: 'post-1', author: 'bob', text: 'Hello World' })

    const entities = builder.build()

    const post = entities.get('Test::Post', 'post-1')
    expect(post).toBeDefined()
    expect(post?.parents).toHaveLength(1)
    expect(post?.parents[0]).toEqual({ type: 'Test::User', id: 'bob' })
  })

  it('should throw an error if no mapper is registered for the type', () => {
    const factory = new EntityBuilderFactory<TestDomain>()
    const builder = factory.createEntityBuilder()

    expect(() => {
      // but here we want to test runtime error when no mapper exists for key 'User'
      builder.add('Test::User', { name: 'alice' })
    }).toThrow(/No mapper registered for entity type: Test::User/)
  })
})
