import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EntityBuilder } from '../../../../src/policy/src/entity-builder.js'
import { GenericZodModel } from '../../../../src/policy/src/providers/GenericZodModel.js'

describe('Model-Agnostic Usage Integration', () => {
  // --- Scenario 1: Orchestrator Route Integration (Mocked Schema) ---
  // This mimics importing DataChannelDefinitionSchema from 'orchestrator'
  const MockDataChannelProtocolEnum = z.enum([
    'http',
    'http:graphql',
    'http:gql',
    'http:grpc',
    'tcp',
  ] as const)
  const MockDataChannelDefinitionSchema = z.object({
    name: z.string(),
    endpoint: z.string().url().optional(),
    protocol: MockDataChannelProtocolEnum,
    region: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })

  type MockRouteData = z.infer<typeof MockDataChannelDefinitionSchema>

  it('should integrate Orchestrator Route schema via GenericZodModel', () => {
    const routeData: MockRouteData = {
      name: 'internal-api',
      endpoint: 'https://internal.api.com',
      protocol: 'http',
      region: 'us-east-1',
      tags: ['internal', 'backend'],
    }

    const routeModel = new GenericZodModel(
      'Route',
      MockDataChannelDefinitionSchema,
      routeData,
      'name' // Use 'name' as the ID
    )

    const builder = EntityBuilder.create()
    const entities = builder.add(routeModel).build()

    // Verify Collection access
    const routeentityRef = entities.entityRef('Route', 'internal-api')
    expect(routeentityRef).toEqual({ type: 'Route', id: 'internal-api' })

    const routeEntity = entities.get('Route', 'internal-api')
    expect(routeEntity).toBeDefined()
    expect(routeEntity?.attrs.protocol).toBe('http')
    expect(routeEntity?.attrs.region).toBe('us-east-1')
  })

  // --- Scenario 2: Auth User Integration (Mocked Schema) ---
  // This mimics importing UserSchema from 'auth'
  const MockUserSchema = z.object({
    id: z.string().startsWith('usr_'),
    email: z.string().email(),
    roles: z.array(z.string()).min(1),
    orgId: z.string().default('default'),
    createdAt: z.date(),
  })

  it('should integrate Auth User schema via GenericZodModel', () => {
    const userData = {
      id: 'usr_123456789012',
      email: 'alice@example.com',
      roles: ['admin', 'editor'],
      orgId: 'org_main',
      createdAt: new Date('2023-01-01T00:00:00Z'),
    }

    const userModel = new GenericZodModel('User', MockUserSchema, userData, 'id')

    const builder = EntityBuilder.create()
    const entities = builder.add(userModel).build()

    const userEntity = entities.get('User', 'usr_123456789012')
    expect(userEntity).toBeDefined()
    // Check date conversion (GenericZodModel converts Date to ISO string)
    expect(userEntity?.attrs.createdAt).toBe('2023-01-01T00:00:00.000Z')
    expect(userEntity?.attrs.roles).toEqual(['admin', 'editor'])
  })

  // --- Scenario 3: Auth ServiceAccount Integration (Mocked Schema) ---
  // This mimics importing ServiceAccountSchema from 'auth'
  const MockServiceAccountSchema = z.object({
    id: z.string().startsWith('sa_'),
    name: z.string(),
    roles: z.array(z.string()),
    expiresAt: z.date(),
  })

  it('should integrate Auth ServiceAccount schema via GenericZodModel', () => {
    const saData = {
      id: 'sa_987654321098',
      name: 'ci-runner',
      roles: ['runner'],
      expiresAt: new Date('2024-01-01T00:00:00Z'),
    }

    const saModel = new GenericZodModel(
      'User', // Mapping ServiceAccount to 'User' entity in Cedar (common pattern)
      MockServiceAccountSchema,
      saData,
      'id'
    )

    const builder = EntityBuilder.create()
    const entities = builder.add(saModel).build()

    const saEntity = entities.get('User', 'sa_987654321098')
    expect(saEntity).toBeDefined()
    expect(saEntity?.attrs.name).toBe('ci-runner')
  })

  // --- Scenario 4: Full Authorization Request Construction ---
  it('should facilitate full authorization request construction', () => {
    // Setup data
    const routeData = {
      name: 'payment-api',
      protocol: 'http' as const,
      tags: ['pci'],
    }
    const userData = {
      id: 'usr_alice',
      email: 'alice@company.com',
      roles: ['admin'],
      orgId: 'default',
      createdAt: new Date(),
    }

    // Build entities
    const builder = EntityBuilder.create()

    builder.add(new GenericZodModel('Route', MockDataChannelDefinitionSchema, routeData, 'name'))

    builder.add(new GenericZodModel('User', MockUserSchema, userData, 'id'))

    const entities = builder.build()

    // Construct Request (Mocking the structure passed to isAuthorized)
    const request = {
      principal: entities.entityRef('User', userData.id),
      action: { type: 'Action', id: 'view' }, // Actions are usually static
      resource: entities.entityRef('Route', routeData.name),
      context: {},
      entities: entities.getAll(),
    }

    expect(request.principal.id).toBe('usr_alice')
    expect(request.resource.id).toBe('payment-api')
    expect(request.entities).toHaveLength(2)
  })

  it('should have all the values on the entities', () => {
    const routeData = {
      name: 'payment-api',
      protocol: 'http' as const,
      tags: ['pci'],
    }
    const builder = EntityBuilder.create()
    const entities = builder
      .add(new GenericZodModel('Route', MockDataChannelDefinitionSchema, routeData, 'name'))
      .build()
    const routeEntity = entities.get('Route', 'payment-api')
    expect(routeEntity).toBeDefined()
    expect(routeEntity?.attrs.tags).toEqual(['pci'])
    expect(routeEntity?.attrs.protocol).toBe('http')
    expect(routeEntity?.uid).toEqual({ type: 'Route', id: 'payment-api' })
    expect(routeEntity?.parents).toEqual([])
  })
})
