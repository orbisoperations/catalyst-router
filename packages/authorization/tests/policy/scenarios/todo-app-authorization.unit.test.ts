import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AuthorizationEngine } from '../../../src/policy/src/authorization-engine.js'
import { EntityBuilderFactory } from '../../../src/policy/src/entity-builder.js'
import { GenericZodModel } from '../../../src/policy/src/providers/GenericZodModel.js'

describe('Todo App Authorization Scenarios', () => {
  // 1. Define Domain Types
  type TodoAppDomain = [
    {
      Namespace: 'TodoApp'
      Actions: 'view' | 'create' | 'edit' | 'delete'
      Entities: {
        User: {
          username: string
          role: string
        }
        TodoList: {
          id: string
          ownerId: string
          title: string
          isPrivate: boolean
        }
        TodoItem: {
          id: string
          listId: string
          content: string
          priority: number
          completed: boolean
        }
      }
    },
  ]

  // 2. Define Schemas
  const UserSchema = z.object({
    username: z.string(),
    role: z.string(),
  })

  const TodoListSchema = z.object({
    id: z.string(),
    ownerId: z.string(), // This will be used as a reference to a User
    title: z.string(),
    isPrivate: z.boolean(),
  })

  // 3. Define Cedar Schema and Policies
  const cedarSchema = `
    namespace TodoApp {
      entity User {
        role: String
      };
      entity TodoList in [User] {
        ownerId: String,
        title: String,
        isPrivate: Bool
      };
      entity TodoItem in [TodoList] {
        listId: String,
        content: String,
        priority: Long,
        completed: Bool
      };

      action view, create, edit, delete appliesTo {
        principal: [User],
        resource: [TodoList, TodoItem]
      };
    }
  `

  const cedarPolicies = `
      // 1. Admin access
      permit(principal, action, resource)
      when { principal.role == "admin" };

      // 2. Owner access via hierarchy
      // We will make TodoList a child of User.
      // We will make TodoItem a child of TodoList.
      // So TodoItem is a descendant of User.
      permit(principal, action, resource)
      when { resource in principal };

      // 3. Public lists access (if not private)
      permit(principal, action == TodoApp::Action::"view", resource is TodoApp::TodoList)
      when { resource.isPrivate == false };
    `

  it('should validate authorization rules for the Todo App domain with manual entities entities', () => {
    // 4. Initialize Engine
    const engine = new AuthorizationEngine<TodoAppDomain>(cedarSchema, cedarPolicies)

    // 5. Build Entities
    const builderFactory = new EntityBuilderFactory<TodoAppDomain>()
    const builder = builderFactory.createEntityBuilder()

    // Users
    const adminUser = { username: 'admin', role: 'admin' }
    const aliceUser = { username: 'alice', role: 'user' }
    const bobUser = { username: 'bob', role: 'user' }

    builder.add(new GenericZodModel('TodoApp::User', UserSchema, adminUser, 'username'))
    builder.add(new GenericZodModel('TodoApp::User', UserSchema, aliceUser, 'username'))
    builder.add(new GenericZodModel('TodoApp::User', UserSchema, bobUser, 'username'))

    // Alice's List -> Parent: Alice
    builder
      .entity('TodoApp::TodoList', 'aliceList')
      .setAttributes({
        ownerId: 'alice',
        title: "Alice's List",
        isPrivate: true,
      })
      .addParent('TodoApp::User', 'alice')

    // Bob's List -> Parent: Bob
    builder
      .entity('TodoApp::TodoList', 'bobList')
      .setAttributes({
        ownerId: 'bob',
        title: "Bob's List",
        isPrivate: true,
      })
      .addParent('TodoApp::User', 'bob')

    // Public List -> Parent: Bob
    builder
      .entity('TodoApp::TodoList', 'publicList')
      .setAttributes({
        ownerId: 'bob',
        title: 'Public List',
        isPrivate: false,
      })
      .addParent('TodoApp::User', 'bob')

    // Items
    // Alice Item -> Parent: Alice List
    builder
      .entity('TodoApp::TodoItem', 'aliceItem')
      .setAttributes({
        listId: 'aliceList',
        content: 'Buy milk',
        priority: 1,
        completed: false,
      })
      .addParent('TodoApp::TodoList', 'aliceList')

    const entities = builder.build()

    // 6. Test Assertions

    // Scenario 1: Alice views her own list (Allowed via hierarchy)
    let result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'aliceList'),
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

    // Scenario 2: Alice views her own item (Allowed via hierarchy: Item -> List -> Alice)
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoItem', 'aliceItem'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }

    // Scenario 3: Alice tries to view Bob's private list (Deny)
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'bobList'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('deny')
    }

    // Scenario 4: Alice views Bob's public list (Allowed via isPrivate == false)
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'publicList'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }

    // Scenario 5: Admin views Bob's private list (Allowed via role == "admin")
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'admin'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'bobList'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })

  it('should validate authorization rules for the Todo App domain with addFromZod', () => {
    const engine = new AuthorizationEngine<TodoAppDomain>(cedarSchema, cedarPolicies)
    const builderFactory = new EntityBuilderFactory<TodoAppDomain>()
    const builder = builderFactory.createEntityBuilder()
    builder.addFromZod(
      'TodoApp::User',
      UserSchema,
      { username: 'admin', role: 'admin' },
      { idField: 'username' }
    )
    builder.addFromZod(
      'TodoApp::User',
      UserSchema,
      { username: 'alice', role: 'user' },
      { idField: 'username' }
    )
    builder.addFromZod(
      'TodoApp::User',
      UserSchema,
      { username: 'bob', role: 'user' },
      { idField: 'username' }
    )

    // add lists
    const aliceList = { id: 'aliceList', ownerId: 'alice', title: "Alice's List", isPrivate: true }
    const bobList = { id: 'bobList', ownerId: 'bob', title: "Bob's List", isPrivate: true }
    const publicList = { id: 'publicList', ownerId: 'bob', title: 'Public List', isPrivate: false }
    builder
      .addFromZod('TodoApp::TodoList', TodoListSchema, aliceList, { idField: 'id' })
      .addParent('TodoApp::User', 'alice')
    builder
      .addFromZod('TodoApp::TodoList', TodoListSchema, bobList, { idField: 'id' })
      .addParent('TodoApp::User', 'bob')
    builder
      .addFromZod('TodoApp::TodoList', TodoListSchema, publicList, { idField: 'id' })
      .addParent('TodoApp::User', 'bob')

    const entities = builder.build()

    // Scenario 1: Alice views her own list (Allowed via hierarchy)
    const result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'aliceList'),
      entities: entities.getAll(),
      context: {},
    })

    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }
  })
  it('should validate authorization rules for the Todo App domain with factory-registered mappers', () => {
    // 4. Initialize Engine
    const engine = new AuthorizationEngine<TodoAppDomain>(cedarSchema, cedarPolicies)

    // 5. Build Entities using Factory Mappers
    const builderFactory = new EntityBuilderFactory<TodoAppDomain>()

    // Register mappers
    builderFactory.registerMapper('TodoApp::User', (user: { username: string; role: string }) => ({
      id: user.username,
      attrs: { role: user.role },
    }))

    builderFactory.registerMapper(
      'TodoApp::TodoList',
      (list: { id: string; ownerId: string; title: string; isPrivate: boolean }) => ({
        id: list.id,
        attrs: { ownerId: list.ownerId, title: list.title, isPrivate: list.isPrivate },
        parents: [{ type: 'TodoApp::User', id: list.ownerId }],
      })
    )

    builderFactory.registerMapper(
      'TodoApp::TodoItem',
      (item: {
        id: string
        listId: string
        content: string
        priority: number
        completed: boolean
      }) => ({
        id: item.id,
        attrs: {
          listId: item.listId,
          content: item.content,
          priority: item.priority,
          completed: item.completed,
        },
        parents: [{ type: 'TodoApp::TodoList', id: item.listId }],
      })
    )

    const builder = builderFactory.createEntityBuilder()

    // Users
    builder.add('TodoApp::User', { username: 'admin', role: 'admin' })
    builder.add('TodoApp::User', { username: 'alice', role: 'user' })
    builder.add('TodoApp::User', { username: 'bob', role: 'user' })

    // Lists
    builder.add('TodoApp::TodoList', {
      id: 'aliceList',
      ownerId: 'alice',
      title: "Alice's List",
      isPrivate: true,
    })
    builder.add('TodoApp::TodoList', {
      id: 'bobList',
      ownerId: 'bob',
      title: "Bob's List",
      isPrivate: true,
    })
    builder.add('TodoApp::TodoList', {
      id: 'publicList',
      ownerId: 'bob',
      title: 'Public List',
      isPrivate: false,
    })

    // Items
    builder.add('TodoApp::TodoItem', {
      id: 'aliceItem',
      listId: 'aliceList',
      content: 'Buy milk',
      priority: 1,
      completed: false,
    })

    const entities = builder.build()

    // 6. Test Assertions (same scenarios as before)

    // Scenario 1: Alice views her own list
    let result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'aliceList'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }

    // Scenario 2: Alice views her own item
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoItem', 'aliceItem'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('allow')
    }

    // Scenario 3: Alice tries to view Bob's private list (Deny)
    result = engine.isAuthorized({
      principal: entities.entityRef('TodoApp::User', 'alice'),
      action: 'TodoApp::Action::view',
      resource: entities.entityRef('TodoApp::TodoList', 'bobList'),
      entities: entities.getAll(),
      context: {},
    })
    expect(result.type).toBe('evaluated')
    if (result.type === 'evaluated') {
      expect(result.decision).toBe('deny')
    }
  })
})
