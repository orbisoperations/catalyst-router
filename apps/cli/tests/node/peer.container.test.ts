import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import path from 'path'
import { spawnSync } from 'node:child_process'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from '@catalyst/orchestrator'

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
  const TIMEOUT = 600000 // 10 minutes
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
  }

  beforeAll(async () => {
    buildImages()

    // Create network
    network = await new Network().start()

    // Start auth service
    console.log('Starting auth service...')
    const authLogs: string[] = []
    auth = await new GenericContainer(authImage)
      .withNetwork(network)
      .withNetworkAliases('auth')
      .withExposedPorts(5000)
      .withEnvironment({
        CATALYST_NODE_ID: 'test-auth-node.somebiz.local.io',
        CATALYST_PEERING_ENDPOINT: 'ws://auth:5000/rpc',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ISSUER: 'catalyst',
        CATALYST_AUTH_KEYS_DB: ':memory:',
        CATALYST_AUTH_TOKENS_DB: ':memory:',
        CATALYST_BOOTSTRAP_TTL: '3600000',
        CATALYST_NODE_ID: 'test-node',
      })
      .withWaitStrategy(Wait.forLogMessage('System Admin Token minted:'))
      .withLogConsumer((stream: NodeJS.ReadableStream) => {
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          authLogs.push(text)
          process.stdout.write(`[auth] ${text}`)
        })
      })
      .start()

    // Extract system token from captured logs
    console.log('Auth service started, extracting system token...')
    let tokenMatch: RegExpMatchArray | null = null
    for (let i = 0; i < 20; i++) {
      const logsData = authLogs.join('')
      tokenMatch = logsData.match(/System Admin Token minted: (eyJ[^\s]+)/)
      if (tokenMatch) break
      await new Promise((r) => setTimeout(r, 100))
    }
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
        PORT: '3000',
        CATALYST_NODE_ID: 'test-node.somebiz.local.io',
        CATALYST_PEERING_ENDPOINT: 'ws://orchestrator:3000/rpc',
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: `ws://auth:5000/rpc`,
        CATALYST_SYSTEM_TOKEN: systemToken,
      })
      .withWaitStrategy(Wait.forLogMessage('NEXT_ORCHESTRATOR_STARTED'))
      .withLogConsumer((stream: NodeJS.ReadableStream) => {
        stream.on('data', (chunk: Buffer) => {
          process.stdout.write(`[orchestrator] ${chunk.toString()}`)
        })
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
    'should create, list, and delete peers via client',
    async () => {
      const orchestratorUrl = `ws://${orchestrator.getHost()}:${orchestrator.getMappedPort(3000)}/rpc`

      // Create client using actual PublicApi
      const client = await newWebSocketRpcSession<PublicApi>(orchestratorUrl)
      const netClientResult = await client.getNetworkClient(systemToken)
      if (!netClientResult.success) {
        throw new Error(`Failed to get network client: ${netClientResult.error}`)
      }
      const netClient = netClientResult.client

      // List peers (should be empty initially)
      const initialList = await netClient.listPeers()
      expect(initialList).toBeInstanceOf(Array)
      const initialCount = initialList.length

      // Create peer
      const createResult = await netClient.addPeer({
        name: 'test-peer.somebiz.local.io',
        endpoint: 'ws://test-peer:3000/rpc',
        domains: ['example.com'],
        connectionStatus: 'disconnected',
      })
      expect(createResult.success).toBe(true)

      // List peers (should have new peer)
      const afterCreate = await netClient.listPeers()
      expect(afterCreate.length).toBe(initialCount + 1)
      const createdPeer = afterCreate.find((p) => p.name === 'test-peer.somebiz.local.io')
      expect(createdPeer).toBeDefined()
      expect(createdPeer?.endpoint).toBe('ws://test-peer:3000/rpc')

      // Delete peer
      const deleteResult = await netClient.removePeer({ name: 'test-peer.somebiz.local.io' })
      expect(deleteResult.success).toBe(true)

      // List peers (should be back to initial count)
      const afterDelete = await netClient.listPeers()
      expect(afterDelete.length).toBe(initialCount)
      const deletedPeer = afterDelete.find((p) => p.name === 'test-peer.somebiz.local.io')
      expect(deletedPeer).toBeUndefined()
    },
    TIMEOUT
  )
})
