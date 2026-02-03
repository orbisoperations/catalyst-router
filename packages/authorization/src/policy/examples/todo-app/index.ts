/* eslint-disable */

import {
  AuthorizationEngine,
  EntityBuilderFactory,
  type AuthorizationDomain,
} from '../../src/index.js'

// 1. Define the Domain
interface TodoDomain extends AuthorizationDomain {
  Actions: 'view' | 'create' | 'update' | 'delete'
  Entities: {
    User: { role: string }
    List: { owner: string; isPublic: boolean }
    Todo: { completed: boolean }
  }
}

// 2. Define Policies
const policies = `
  permit(
    principal,
    action,
    resource
  )
  when { resource.owner == principal.id };

  permit(
    principal,
    action == Action::"view",
    resource
  )
  when { resource.isPublic == true };

  permit(
    principal,
    action,
    resource
  )
  when { principal.role == "admin" };
`

// 3. Mock Data
const users = [
  { id: 'alice', role: 'user' },
  { id: 'bob', role: 'admin' },
  { id: 'charlie', role: 'user' },
]

const todoLists = [
  { id: 'list-1', owner: 'alice', isPublic: false, title: "Alice's Private List" },
  { id: 'list-2', owner: 'alice', isPublic: true, title: "Alice's Public List" },
  { id: 'list-3', owner: 'charlie', isPublic: false, title: "Charlie's Private List" },
]

const todos = [
  { id: 'todo-1', listId: 'list-1', text: 'Buy Milk', completed: false },
  { id: 'todo-2', listId: 'list-2', text: 'Walk Dog', completed: true },
]

// 4. Setup Engine & Factory with Mappers
const engine = new AuthorizationEngine<TodoDomain>('namespace TodoApp', policies)
const factory = new EntityBuilderFactory<TodoDomain>()

// Register Mappers to transform raw data into Cedar entities
factory
  .registerMapper('User', (user: (typeof users)[0]) => ({
    id: user.id,
    attrs: { role: user.role },
  }))
  .registerMapper('List', (list: (typeof todoLists)[0]) => ({
    id: list.id,
    attrs: { owner: list.owner, isPublic: list.isPublic },
  }))
  .registerMapper('Todo', (todo: (typeof todos)[0]) => ({
    id: todo.id,
    attrs: { completed: todo.completed },
    parents: [{ type: 'List', id: todo.listId }], // Link Todo to its List
  }))

// 5. Build Entity Store
const builder = factory.createEntityBuilder()

// Add all data using the registered mappers
users.forEach((u) => builder.add('User', u))
todoLists.forEach((l) => builder.add('List', l))
todos.forEach((t) => builder.add('Todo', t))

const entities = builder.build()

// 6. Run Checks
async function checkAccess(
  principalId: string,
  actionId: string,
  resourceType: string,
  resourceId: string
) {
  const result = engine.isAuthorized({
    principal: { type: 'User', id: principalId },
    action: { type: 'Action', id: actionId as any },
    resource: { type: resourceType as any, id: resourceId },
    entities,
  })

  if (result.type === 'failure') {
    console.error('Engine error:', result.errors)
    return
  }

  console.log(
    `User ${principalId} ${actionId} ${resourceType}::"${resourceId}" -> ${result.decision}`
  )
}

console.log('--- Authorization Checks ---')
// Alice accessing her own private list -> Allow
checkAccess('alice', 'view', 'List', 'list-1')

// Charlie accessing Alice's private list -> Deny
checkAccess('charlie', 'view', 'List', 'list-1')

// Charlie accessing Alice's public list -> Allow
checkAccess('charlie', 'view', 'List', 'list-2')

// Bob (admin) accessing anything -> Allow
checkAccess('bob', 'delete', 'List', 'list-3')

// Alice updating a todo in her list -> Allow (inherited ownership logic could be added)
// Note: Simpler policy above just checks direct ownership on the resource.
// For Todos, we might want a policy saying: "Access Todo if you own the parent List"
// Let's assume for this simple example we just check lists.
