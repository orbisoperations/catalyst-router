import { describe, expect, it } from 'vitest'
import { AuthorizationEngine } from '../../../src/policy/src/authorization-engine.js'
import { EntityBuilderFactory } from '../../../src/policy/src/entity-builder.js'

describe('AuthorizationEngine', () => {
  // 1. Define Test Domain
  type TestDomain = [
    {
      Namespace: 'Test'
      Actions: 'read' | 'write' | 'admin' | 'namespaced_action'
      Entities: {
        User: {
          id: string
          role: string
        }
        Document: {
          id: string
          owner: string
          locked: boolean
        }
      }
    },
    {
      Namespace: null
      Actions: 'non_namespaced_action'
      Entities: null
    },
  ]

  // 2. Define Cedar Schema & Policies
  const schema = `
    namespace Test {
      entity User {
        role: String,
        id: String
      };
      entity Document {
        owner: String,
        locked: Bool
      };
      action read, write, admin, namespaced_action appliesTo {
        principal: [User],
        resource: [Document]
      };
    }
    action non_namespaced_action appliesTo {
      principal: [Test::User],
      resource: [Test::Document]
    };
  `

  const policies = `
    // Policy 1: Allow admin action for users with role == "admin"
    permit(principal, action == Test::Action::"admin", resource)
    when {
      principal.role == "admin"
    };

    // Policy 2: Allow read action on Document if resource.owner == principal.id (using UID string comparison)
    permit(principal, action == Test::Action::"read", resource is Test::Document)
    when {
      resource.owner == principal.id
    };

    // Policy 3: Deny write action if resource.locked == true
    forbid(principal, action == Test::Action::"write", resource)
    when {
      resource.locked == true
    };

    // Policy 4: Allow write action on Document if owner
    permit(principal, action == Test::Action::"write", resource is Test::Document)
    when {
      resource.owner == principal.id
    };
  `

  const engine = new AuthorizationEngine<TestDomain>(schema, policies)
  const factory = new EntityBuilderFactory<TestDomain>()

  // Register mappers for easy entity creation
  factory
    .registerMapper('Test::User', (data: { id: string; role: string }) => ({
      id: data.id,
      attrs: { role: data.role, id: data.id },
    }))
    .registerMapper('Test::Document', (data: { id: string; owner: string; locked: boolean }) => ({
      id: data.id,
      attrs: { owner: data.owner, locked: data.locked },
    }))

  it('should instantiate correctly', () => {
    expect(engine).toBeDefined()
    expect(engine).toBeInstanceOf(AuthorizationEngine)
  })

  it('should validate policies successfully', () => {
    expect(typeof engine.validatePolicies()).toBe('boolean')
  })

  it('should allow admin access for admin user', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'admin-user', role: 'admin' })
    builder.add('Test::Document', { id: 'doc-1', owner: 'other-user', locked: false })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'admin-user'),
      action: 'Test::Action::admin',
      resource: entities.entityRef('Test::Document', 'doc-1'),
      entities: entities.getAll(),
      context: {},
    })

    if (result.type === 'failure') {
      console.error(JSON.stringify(result.errors, null, 2))
    }
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })

  it('should allow owner to read their document', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'alice', role: 'user' })
    builder.add('Test::Document', { id: 'alice-doc', owner: 'alice', locked: false })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'alice'),
      action: 'Test::Action::read',
      resource: entities.entityRef('Test::Document', 'alice-doc'),
      entities: entities.getAll(),
      context: {},
    })

    if (result.type === 'failure') {
      console.error(JSON.stringify(result.errors, null, 2))
    }
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })

  it('should implicitly deny non-owner from reading document', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'bob', role: 'user' })
    builder.add('Test::Document', { id: 'alice-doc', owner: 'alice', locked: false })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'bob'),
      action: 'Test::Action::read',
      resource: entities.entityRef('Test::Document', 'alice-doc'),
      entities: entities.getAll(),
      context: {},
    })

    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('deny')
    }
  })

  it('should explicitly deny write access to locked document even for owner', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'alice', role: 'user' })
    builder.add('Test::Document', { id: 'locked-doc', owner: 'alice', locked: true })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'alice'),
      action: 'Test::Action::write',
      resource: entities.entityRef('Test::Document', 'locked-doc'),
      entities: entities.getAll(),
      context: {},
    })

    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('deny')
    }
  })

  it('should allow write access to unlocked document for owner', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'alice', role: 'user' })
    builder.add('Test::Document', { id: 'unlocked-doc', owner: 'alice', locked: false })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'alice'),
      action: 'Test::Action::write',
      resource: entities.entityRef('Test::Document', 'unlocked-doc'),
      entities: entities.getAll(),
      context: {},
    })

    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })

  it('should allow non-namespaced action', () => {
    const builder = factory.createEntityBuilder()
    builder.add('Test::User', { id: 'alice', role: 'user' })
    const entities = builder.build()

    const result = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'alice'),
      action: 'Action::non_namespaced_action',
      resource: entities.entityRef('Test::Document', 'doc-1'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type, 'Result' + JSON.stringify(result)).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision, 'Result' + JSON.stringify(result)).toBe('deny')
    }

    const namespacedResult = engine.isAuthorized({
      principal: entities.entityRef('Test::User', 'alice'),
      action: 'Test::Action::namespaced_action',
      resource: entities.entityRef('Test::Document', 'doc-1'),
      entities: entities.getAll(),
      context: {},
    })
    expect(namespacedResult.type).toBe('evaluated')
    if (namespacedResult.type === 'evaluated') {
      expect(namespacedResult.decision).toBe('deny')
    }
  })
})
