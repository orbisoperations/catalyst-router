import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import { createOrchestratorClient } from '../../src/clients/orchestrator-client.js'

const isDockerRunning = () => {
  try {
    const result = Bun.spawnSync(['docker', 'info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning() || !process.env.CATALYST_CONTAINER_TESTS_ENABLED
if (skipTests) {
  console.warn(
    'Skipping route container tests: Docker not running or CATALYST_CONTAINER_TESTS_ENABLED not set'
  )
}

describe.skipIf(skipTests)('Route Commands Container Tests', () => {
  const TIMEOUT = 300000 // 5 minutes
  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const authImage = 'catalyst-auth:next-topology-e2e'
  const repoRoot = path.resolve(__dirname, '../../../../')

  let network: StartedNetwork
  let auth: StartedTestContainer
  let orchestrator: StartedTestContainer
  let systemToken: string

  beforeAll(async () => {
    console.log('Building images...')
    // Build orchestrator image
    const orchestratorBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
      { cwd: repoRoot }
    )
    if (orchestratorBuild.exitCode !== 0) {
      throw new Error('Failed to build orchestrator image')
    }

    // Build auth image
    const authBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/auth/Dockerfile', '-t', authImage, '.'],
      { cwd: repoRoot }
    )
    if (authBuild.exitCode !== 0) {
      throw new Error('Failed to build auth image')
    }

    // Create network
    network = await new Network().start()

    // Start auth service
    console.log('Starting auth service...')
    auth = await new GenericContainer(authImage)
      .withNetwork(network)
      .withNetworkAliases('auth')
      .withExposedPorts(5000)
      .withEnvironment({
        CATALYST_AUTH_ISSUER: 'catalyst',
        CATALYST_AUTH_KEYS_DB: ':memory:',
        CATALYST_AUTH_TOKENS_DB: ':memory:',
        CATALYST_BOOTSTRAP_TTL: '3600000',
        CATALYST_NODE_ID: 'test-node',
      })
      .withWaitStrategy(Wait.forLogMessage('Auth service started'))
      .start()

    // Extract system token from logs
    const authLogs = await auth.logs()
    let logsData = ''
    for await (const chunk of authLogs) {
      logsData += chunk.toString()
    }
    const tokenMatch = logsData.match(/System Admin Token minted: (eyJ[^\s]+)/)
    if (!tokenMatch) {
      throw new Error('Failed to extract system token from auth logs')
    }
    systemToken = tokenMatch[1]
    console.log('Extracted system token:', systemToken.substring(0, 20) + '...')

    // Start orchestrator
    console.log('Starting orchestrator...')
    orchestrator = await new GenericContainer(orchestratorImage)
      .withNetwork(network)
      .withNetworkAliases('orchestrator')
      .withExposedPorts(3000)
      .withEnvironment({
        CATALYST_NODE_ID: 'test-node',
        CATALYST_ORG_DOMAIN: 'test.local',
        CATALYST_ORCHESTRATOR_AUTH_ENDPOINT: 'ws://auth:5000/rpc',
        CATALYST_ORCHESTRATOR_AUTH_SYSTEM_TOKEN: systemToken,
      })
      .withWaitStrategy(Wait.forLogMessage('Orchestrator (Next) running'))
      .start()

    console.log('Containers started successfully')
  }, TIMEOUT)

  afterAll(async () => {
    await orchestrator?.stop()
    await auth?.stop()
    await network?.stop()
  }, TIMEOUT)

  it(
    'should create, list, and delete routes via client',
    async () => {
      const orchestratorUrl = `ws://${orchestrator.getHost()}:${orchestrator.getMappedPort(3000)}/rpc`

      // Create client
      const client = await createOrchestratorClient(orchestratorUrl)
      const mgmtScope = client.connectionFromManagementSDK()

      // List routes (check initial state)
      const initialList = await mgmtScope.listLocalRoutes()
      expect(initialList.routes).toBeDefined()
      expect(initialList.routes.local).toBeInstanceOf(Array)
      const initialCount = initialList.routes.local.length

      // Create route
      const createResult = await mgmtScope.applyAction({
        resource: 'localRoute',
        resourceAction: 'create',
        data: {
          name: 'test-service',
          endpoint: 'http://test-service:8080',
          protocol: 'http:graphql',
        },
      })
      expect(createResult.success).toBe(true)

      // List routes (should have new route)
      const afterCreate = await mgmtScope.listLocalRoutes()
      expect(afterCreate.routes.local.length).toBe(initialCount + 1)
      const createdRoute = afterCreate.routes.local.find((r) => r.name === 'test-service')
      expect(createdRoute).toBeDefined()
      expect(createdRoute?.endpoint).toBe('http://test-service:8080')
      expect(createdRoute?.protocol).toBe('http:graphql')

      // Delete route
      const deleteResult = await mgmtScope.applyAction({
        resource: 'localRoute',
        resourceAction: 'delete',
        data: {
          name: 'test-service',
        },
      })
      expect(deleteResult.success).toBe(true)

      // List routes (should be back to initial count)
      const afterDelete = await mgmtScope.listLocalRoutes()
      expect(afterDelete.routes.local.length).toBe(initialCount)
      const deletedRoute = afterDelete.routes.local.find((r) => r.name === 'test-service')
      expect(deletedRoute).toBeUndefined()
    },
    TIMEOUT
  )
})
