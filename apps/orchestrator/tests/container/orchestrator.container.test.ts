import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'

import { spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { TEST_IMAGES } from '../../../../tests/docker-images.js'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from '../../src/orchestrator'

const isDockerRunning = () => {
  try {
    const result = spawnSync('docker', ['info'])
    return result.status === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping container tests: Docker is not running')
}

describe.skipIf(skipTests)('Orchestrator Container Tests (Next)', () => {
  const TIMEOUT = 600000 // 10 minutes

  let network: StartedNetwork
  let auth: StartedTestContainer
  let nodeA: StartedTestContainer
  let nodeB: StartedTestContainer
  let nodeC: StartedTestContainer
  let systemToken: string

  beforeAll(async () => {
    network = await new Network().start()

    // Start auth service first
    console.log('Starting auth service...')
    const authLogs: string[] = []
    auth = await new GenericContainer(TEST_IMAGES.auth)
      .withNetwork(network)
      .withNetworkAliases('auth')
      .withExposedPorts(5000)
      .withEnvironment({
        PORT: '5000',
        CATALYST_NODE_ID: 'auth',
        CATALYST_PEERING_ENDPOINT: 'ws://auth:5000/rpc',
        CATALYST_BOOTSTRAP_TOKEN: 'test-bootstrap-token',
        CATALYST_AUTH_KEYS_DB: ':memory:',
        CATALYST_AUTH_TOKENS_DB: ':memory:',
      })
      .withWaitStrategy(Wait.forLogMessage('System Admin Token minted:'))
      .withLogConsumer((stream: Readable) => {
        stream.on('data', (chunk) => {
          const text = chunk.toString()
          authLogs.push(text)
          process.stdout.write(text)
        })
      })
      .start()

    console.log('Auth service started, extracting system token...')

    // Extract system token from logs (with retry for race condition)
    let tokenLog: string | undefined
    for (let i = 0; i < 20; i++) {
      tokenLog = authLogs.find((line) => line.includes('System Admin Token minted:'))
      if (tokenLog) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!tokenLog) {
      throw new Error('Failed to find system token in auth service logs')
    }
    systemToken = tokenLog.split('System Admin Token minted:')[1].trim()
    console.log(`Extracted system token: ${systemToken.substring(0, 20)}...`)

    const startNode = async (name: string, alias: string) => {
      return await new GenericContainer(TEST_IMAGES.orchestrator)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withExposedPorts(3000)
        .withEnvironment({
          PORT: '3000',
          CATALYST_NODE_ID: name,
          CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
          CATALYST_DOMAINS: 'somebiz.local.io',
          CATALYST_AUTH_ENDPOINT: 'ws://auth:5000/rpc',
          CATALYST_SYSTEM_TOKEN: systemToken,
        })
        .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
        .withLogConsumer((stream: Readable) => {
          stream.pipe(process.stdout)
        })
        .start()
    }

    nodeA = await startNode('node-a.somebiz.local.io', 'node-a')
    nodeB = await startNode('node-b.somebiz.local.io', 'node-b')
    nodeC = await startNode('node-c.somebiz.local.io', 'node-c')

    console.log('Nodes started')
  }, TIMEOUT)

  afterAll(async () => {
    console.log('Teardown: Starting...')
    try {
      if (nodeA) await nodeA.stop()
      if (nodeB) await nodeB.stop()
      if (nodeC) await nodeC.stop()
      if (auth) await auth.stop()
      if (network) await network.stop()
      console.log('Teardown: Success')
    } catch (e) {
      console.error('Teardown failed', e)
    }
  }, TIMEOUT)

  const getClient = (node: StartedTestContainer) => {
    const port = node.getMappedPort(3000)
    return newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${port}/rpc`)
  }

  it(
    'A <-> B: peering and route sync',
    async () => {
      const clientA = getClient(nodeA)
      const clientB = getClient(nodeB)

      // Use system admin token for test operations
      const netAResult = await clientA.getNetworkClient(systemToken)
      const netBResult = await clientB.getNetworkClient(systemToken)

      if (!netAResult.success || !netBResult.success) {
        throw new Error('Failed to get network client')
      }

      const netA = netAResult.client
      const netB = netBResult.client

      // Setup B to accept A first, then A connects to B
      await netB.addPeer({
        name: 'node-a.somebiz.local.io',
        endpoint: 'ws://node-a:3000/rpc',
        domains: ['somebiz.local.io'],
        peerToken: systemToken,
      })
      await netA.addPeer({
        name: 'node-b.somebiz.local.io',
        endpoint: 'ws://node-b:3000/rpc',
        domains: ['somebiz.local.io'],
        peerToken: systemToken,
      })

      // Give it a moment for the handshake
      await new Promise((r) => setTimeout(r, 2000))

      // A adds a route
      const dataAResult = await clientA.getDataChannelClient(systemToken)
      if (!dataAResult.success) throw new Error(`Failed to get data client: ${dataAResult.error}`)

      await dataAResult.client.addRoute({
        name: 'service-a',
        endpoint: 'http://a:8080',
        protocol: 'http',
      })

      // Check B learned it
      let learnedOnB = false
      for (let i = 0; i < 20; i++) {
        const dataBResult = await clientB.getDataChannelClient(systemToken)
        if (!dataBResult.success) throw new Error('Failed to get data client B')
        const routes = await dataBResult.client.listRoutes()
        if (routes.internal.some((r) => r.name === 'service-a')) {
          learnedOnB = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(learnedOnB).toBe(true)
    },
    TIMEOUT
  )

  it(
    'A <-> B <-> C: transit route propagation with nodePath',
    async () => {
      const clientB = getClient(nodeB)
      const clientC = getClient(nodeC)

      const netBResult = await clientB.getNetworkClient(systemToken)
      const netCResult = await clientC.getNetworkClient(systemToken)

      if (!netBResult.success || !netCResult.success) {
        throw new Error('Failed to get network client')
      }

      const netB = netBResult.client
      const netC = netCResult.client

      // Setup C to accept B first, then B connects to C
      await netC.addPeer({
        name: 'node-b.somebiz.local.io',
        endpoint: 'ws://node-b:3000/rpc',
        domains: ['somebiz.local.io'],
        peerToken: systemToken,
      })
      await netB.addPeer({
        name: 'node-c.somebiz.local.io',
        endpoint: 'ws://node-c:3000/rpc',
        domains: ['somebiz.local.io'],
        peerToken: systemToken,
      })

      // Give it a moment for the handshake
      await new Promise((r) => setTimeout(r, 2000))

      // Verify node C learned service-a via node B
      let learnedOnC = false
      for (let i = 0; i < 20; i++) {
        const dataCResult = await clientC.getDataChannelClient(systemToken)
        if (!dataCResult.success) throw new Error('Failed to get data client C')
        const routes = await dataCResult.client.listRoutes()
        const routeA = routes.internal.find((r) => r.name === 'service-a')
        if (routeA) {
          learnedOnC = true
          expect(routeA.nodePath).toEqual(['node-b.somebiz.local.io', 'node-a.somebiz.local.io'])
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(learnedOnC).toBe(true)
    },
    TIMEOUT
  )
})
