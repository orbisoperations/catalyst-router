import { describe, expect, it } from 'bun:test'
import { AuthorizationEngine } from '../../../src/policy/src/authorization-engine.js'

describe('Namespaced Authorization', () => {
  type MyDomain = [
    {
      Namespace: 'MyApp'
      Actions: 'view'
      Entities: {
        User: { role: string }
        Resource: { owner: string }
      }
    },
  ]

  const schema = `
    namespace MyApp {
      entity User {
        role: String
      };
      entity Resource {
        owner: String
      };
      action view appliesTo {
        principal: [User],
        resource: [Resource]
      };
    }
  `

  const policies = `
    permit(
      principal,
      action == MyApp::Action::"view",
      resource
    );
  `

  it('should correctly handle namespaced entities and actions', () => {
    // 1. Initialize Engine
    const engine = new AuthorizationEngine<MyDomain>(schema, policies)
    expect(engine.validatePolicies()).toBe(true)

    // 2. Build entities
    const builder = engine.getEntityBuilder()

    // 3. Create entities (fully qualified)
    builder.entity('MyApp::User', 'alice').setAttributes({ role: 'admin' })
    builder.entity('MyApp::Resource', 'file1').setAttributes({ owner: 'alice' })

    const entities = builder.build()

    // 4. Verify entities have namespaced types
    const user = entities.get('MyApp::User', 'alice')
    expect(user).toBeDefined()
    expect(user?.uid.type).toBe('MyApp::User')

    // 5. Check authorization
    const result = engine.isAuthorized({
      principal: { type: 'MyApp::User', id: 'alice' },
      action: 'MyApp::Action::view',
      resource: { type: 'MyApp::Resource', id: 'file1' },
      entities: entities,
    })

    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })

  it('should handle entityRef with namespace', () => {
    const engine = new AuthorizationEngine<MyDomain>(schema, policies)
    const builder = engine.getEntityBuilder()
    builder.entity('MyApp::User', 'bob')
    const entities = builder.build()

    const ref = entities.entityRef('MyApp::User', 'bob')
    expect(ref.type).toBe('MyApp::User')
    expect(ref.id).toBe('bob')
  })
})

describe('Multiple namespaces', () => {
  type MultiNamespaceDomain = [
    {
      Namespace: 'MyApp'
      Actions: null
      Entities: {
        User: { role: string }
        Resource: { owner: string }
      }
    },
    {
      Namespace: 'MyApp2'
      Actions: null
      Entities: {
        User: { role: string }
        Resource: { owner: string }
      }
    },
    {
      Namespace: 'MyApp3'
      Actions: null
      Entities: {
        User: { role: string }
        Resource: { owner: string }
      }
    },
    {
      Namespace: null
      Actions: 'view'
      Entities: null
    },
  ]

  const schema = `
    namespace MyApp {
      entity User {
        role: String
      };
      entity Resource {
        owner: String
      };
    }

    namespace MyApp2 {
      entity User {
        role: String
      };
      entity Resource {
        owner: String
      };
    }

    namespace MyApp3 {
      entity User {
        role: String
      };
      entity Resource {
        owner: String
      };
    }

    action view appliesTo {
      principal: [MyApp::User, MyApp2::User, MyApp3::User],
      resource: [MyApp::Resource, MyApp2::Resource, MyApp3::Resource]
    };
  `

  const policies = `
    permit(
      principal,
      action == Action::"view",
      resource
    );
  `

  it('should validate policies', () => {
    const engine = new AuthorizationEngine<MultiNamespaceDomain>(schema, policies)
    expect(engine.validatePolicies()).toBe(true)
  })

  it('multiple namespaces with entity builder', () => {
    const engine = new AuthorizationEngine<MultiNamespaceDomain>(schema, policies)
    const builder = engine.getEntityBuilder()
    builder.entity('MyApp::User', 'alice').setAttributes({ role: 'admin' })
    builder.entity('MyApp::Resource', 'file1').setAttributes({ owner: 'alice' })
    builder.entity('MyApp2::User', 'bob').setAttributes({ role: 'user' })
    builder.entity('MyApp2::Resource', 'file2').setAttributes({ owner: 'bob' })
    builder.entity('MyApp3::User', 'charlie').setAttributes({ role: 'admin' })
    builder.entity('MyApp3::Resource', 'file3').setAttributes({ owner: 'charlie' })
    const entities = builder.build()
    expect(entities.get('MyApp::User', 'alice')).toBeDefined()
    expect(entities.get('MyApp::Resource', 'file1')).toBeDefined()
    expect(entities.get('MyApp2::User', 'bob')).toBeDefined()
    expect(entities.get('MyApp2::Resource', 'file2')).toBeDefined()
    expect(entities.get('MyApp3::User', 'charlie')).toBeDefined()
    expect(entities.get('MyApp3::Resource', 'file3')).toBeDefined()
    const result = engine.isAuthorized({
      principal: entities.entityRef('MyApp::User', 'alice'),
      action: 'Action::view',
      resource: entities.entityRef('MyApp::Resource', 'file1'),
      entities: entities,
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })
})
