import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import path from 'path'
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
    'Skipping peer container tests: Docker not running or CATALYST_CONTAINER_TESTS_ENABLED not set'
  )
}

describe.skipIf(skipTests)('Peer Commands Container Tests', () => {
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
        CATALYST_NODE_ID: 'test-auth-node',
        CATALYST_PEERING_ENDPOINT: 'ws://auth:5000/rpc',
        CATALYST_DOMAINS: 'test.local',
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
        CATALYST_DOMAINS: 'test.local',
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
    'should create, list, and delete peers via client',
    async () => {
      const orchestratorUrl = `ws://${orchestrator.getHost()}:${orchestrator.getMappedPort(3000)}/rpc`

      // Create client
      const client = await createOrchestratorClient(orchestratorUrl)
      const mgmtScope = client.connectionFromManagementSDK()

      // List peers (should be empty initially)
      const initialList = await mgmtScope.listPeers()
      expect(initialList.peers).toBeInstanceOf(Array)
      const initialCount = initialList.peers.length

      // Create peer
      const createResult = await mgmtScope.applyAction({
        resource: 'internalBGPConfig',
        resourceAction: 'create',
        data: {
          name: 'test-peer.example.com',
          endpoint: 'ws://test-peer:3000/rpc',
          domains: ['example.com'],
        },
      })
      expect(createResult.success).toBe(true)

      // List peers (should have new peer)
      const afterCreate = await mgmtScope.listPeers()
      expect(afterCreate.peers.length).toBe(initialCount + 1)
      const createdPeer = afterCreate.peers.find((p) => p.name === 'test-peer.example.com')
      expect(createdPeer).toBeDefined()
      expect(createdPeer?.endpoint).toBe('ws://test-peer:3000/rpc')

      // Delete peer
      const deleteResult = await mgmtScope.deletePeer('test-peer.example.com')
      expect(deleteResult.success).toBe(true)

      // List peers (should be back to initial count)
      const afterDelete = await mgmtScope.listPeers()
      expect(afterDelete.peers.length).toBe(initialCount)
      const deletedPeer = afterDelete.peers.find((p) => p.name === 'test-peer.example.com')
      expect(deletedPeer).toBeUndefined()
    },
    TIMEOUT
  )
})
