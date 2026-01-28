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
import type { Readable } from 'node:stream'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from '../src/orchestrator.js'

const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED
if (skipTests) {
  console.warn('Skipping container tests: CATALYST_CONTAINER_TESTS_ENABLED not set')
}

describe.skipIf(skipTests)('Orchestrator Container Tests (Next)', () => {
  const TIMEOUT = 600000 // 10 minutes

  let network: StartedNetwork
  let nodeA: StartedTestContainer
  let nodeB: StartedTestContainer
  let nodeC: StartedTestContainer

  const orchestratorImage = 'catalyst-node:next-topology-e2e'

  beforeAll(async () => {
    // Build image if not exists
    const checkImage = spawnSync('docker', ['image', 'inspect', orchestratorImage])
    if (checkImage.status !== 0) {
      console.log('Building Orchestrator image for Container tests...')
      const repoRoot = path.resolve(__dirname, '../../../')
      const orchestratorBuild = spawnSync(
        'docker',
        ['build', '-f', 'packages/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
        { cwd: repoRoot, stdio: 'inherit' }
      )
      if (orchestratorBuild.status !== 0) throw new Error('Docker build orchestrator failed')
    }

    network = await new Network().start()

    const startNode = async (name: string, alias: string) => {
      return await new GenericContainer(orchestratorImage)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withExposedPorts(3000)
        .withEnvironment({
          PORT: '3000',
          CATALYST_NODE_ID: name,
          CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
          CATALYST_DOMAINS: 'somebiz.local.io',
          CATALYST_PEERING_SECRET: 'valid-secret',
        })
        .withWaitStrategy(Wait.forLogMessage('NEXT_ORCHESTRATOR_STARTED'))
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

      const netAResult = await clientA.getNetworkClient('valid-secret')
      const netBResult = await clientB.getNetworkClient('valid-secret')

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
      })
      await netA.addPeer({
        name: 'node-b.somebiz.local.io',
        endpoint: 'ws://node-b:3000/rpc',
        domains: ['somebiz.local.io'],
      })

      // Give it a moment for the handshake
      await new Promise((r) => setTimeout(r, 2000))

      // A adds a route
      const dataAResult = await clientA.getDataCustodianClient('valid-secret')
      if (!dataAResult.success) throw new Error(`Failed to get data client: ${dataAResult.error}`)

      await dataAResult.client.addRoute({
        name: 'service-a',
        endpoint: 'http://a:8080',
        protocol: 'http',
      })

      // Check B learned it
      let learnedOnB = false
      for (let i = 0; i < 20; i++) {
        const dataBResult = await clientB.getDataCustodianClient('valid-secret')
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

      const netBResult = await clientB.getNetworkClient('valid-secret')
      const netCResult = await clientC.getNetworkClient('valid-secret')

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
      })
      await netB.addPeer({
        name: 'node-c.somebiz.local.io',
        endpoint: 'ws://node-c:3000/rpc',
        domains: ['somebiz.local.io'],
      })

      // Give it a moment for the handshake
      await new Promise((r) => setTimeout(r, 2000))

      // Verify node C learned service-a via node B
      let learnedOnC = false
      for (let i = 0; i < 20; i++) {
        const dataCResult = await clientC.getDataCustodianClient('valid-secret')
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
