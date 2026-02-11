import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
import type { Readable } from 'stream'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import { createOrchestratorClient } from '../../src/clients/orchestrator-client.js'
import { startAuthService } from '../auth-test-helpers.js'

const isDockerRunning = () => {
  try {
    const result = Bun.spawnSync(['docker', 'info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
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

    // Start auth service and extract system token
    const authCtx = await startAuthService(network, 'auth', authImage, {
      CATALYST_AUTH_ISSUER: 'catalyst',
      CATALYST_BOOTSTRAP_TTL: '3600000',
    })
    auth = authCtx.container
    systemToken = authCtx.systemToken

    // Start orchestrator
    console.log('Starting orchestrator...')
    orchestrator = await new GenericContainer(orchestratorImage)
      .withNetwork(network)
      .withNetworkAliases('orchestrator')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_NODE_ID: 'test-orquestrator-node.somebiz.local.io',
        CATALYST_PEERING_ENDPOINT: 'ws://orchestrator:3000/rpc',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: 'ws://auth:5000/rpc',
        CATALYST_SYSTEM_TOKEN: systemToken,
      })
      .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
      .withLogConsumer((stream: Readable) => {
        stream.pipe(process.stdout)
      })
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

      // Create client using the actual PublicApi with system token for auth
      const client = await createOrchestratorClient(orchestratorUrl)
      const dataChannelResult = await client.getDataChannelClient(systemToken)
      expect(dataChannelResult.success).toBe(true)
      if (!dataChannelResult.success) return
      const dataChannel = dataChannelResult.client

      // List routes (check initial state)
      const initialList = await dataChannel.listRoutes()
      expect(initialList.local).toBeInstanceOf(Array)
      const initialCount = initialList.local.length

      // Create route
      const createResult = await dataChannel.addRoute({
        name: 'test-service',
        endpoint: 'http://test-service:8080',
        protocol: 'http:graphql',
      })
      expect(createResult.success).toBe(true)

      // List routes (should have new route)
      const afterCreate = await dataChannel.listRoutes()
      expect(afterCreate.local.length).toBe(initialCount + 1)
      const createdRoute = afterCreate.local.find((r) => r.name === 'test-service')
      expect(createdRoute).toBeDefined()
      expect(createdRoute?.endpoint).toBe('http://test-service:8080')
      expect(createdRoute?.protocol).toBe('http:graphql')

      // Delete route
      const deleteResult = await dataChannel.removeRoute({
        name: 'test-service',
        protocol: 'http:graphql',
      })
      expect(deleteResult.success).toBe(true)

      // List routes (should be back to initial count)
      const afterDelete = await dataChannel.listRoutes()
      expect(afterDelete.local.length).toBe(initialCount)
      const deletedRoute = afterDelete.local.find((r) => r.name === 'test-service')
      expect(deletedRoute).toBeUndefined()
    },
    TIMEOUT
  )
})
