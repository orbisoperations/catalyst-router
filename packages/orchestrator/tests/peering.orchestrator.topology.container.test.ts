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
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import type { PublicApi, NetworkClient } from '../src/orchestrator.js'

const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED
if (skipTests) {
  console.warn('Skipping container tests: CATALYST_CONTAINER_TESTS_ENABLED not set')
}

describe.skipIf(skipTests)('Orchestrator Peering Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes

  let network: StartedNetwork
  let nodeA: StartedTestContainer
  let nodeB: StartedTestContainer

  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const repoRoot = path.resolve(__dirname, '../../../')

  beforeAll(async () => {
    // Check if image exists
    const checkImage = spawnSync('docker', ['image', 'inspect', orchestratorImage])
    if (checkImage.status !== 0) {
      console.log('Building Orchestrator image for Topology tests...')
      const orchestratorBuild = spawnSync(
        'docker',
        ['build', '-f', 'packages/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
        { cwd: repoRoot, stdio: 'inherit' }
      )
      if (orchestratorBuild.status !== 0) throw new Error('Docker build orchestrator failed')
    } else {
      console.log(`Using existing image: ${orchestratorImage}`)
    }

    network = await new Network().start()

    const startNode = async (name: string, alias: string) => {
      console.log(`Starting node ${name}...`)
      const container = await new GenericContainer(orchestratorImage)
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
        .withLogConsumer(
          (stream: {
            on(event: string, listener: (line: string) => void): void
            pipe?: (dest: NodeJS.WritableStream) => void
          }) => {
            if (stream.pipe) stream.pipe(process.stdout)

            stream.on('line', (line: string) => {
              process.stdout.write(`[${name}] ${line}\n`)
            })
            stream.on('err', (line: string) => process.stderr.write(`[${name}] ERR: ${line}\n`))
          }
        )
        .start()
      console.log(`Node ${name} started and healthy.`)
      return container
    }

    nodeA = await startNode('node-a.somebiz.local.io', 'node-a')
    nodeB = await startNode('node-b.somebiz.local.io', 'node-b')

    console.log('All nodes started.')
  }, TIMEOUT)

  afterAll(async () => {
    console.log('Teardown: Starting...')
    try {
      if (nodeA) await nodeA.stop()
      if (nodeB) await nodeB.stop()
      if (network) await network.stop()
      console.log('Teardown: Success')
    } catch (e) {
      console.error('Teardown: Error during stop (ignoring for test result)', e)
    }
  })

  const getClient = (node: StartedTestContainer) => {
    const port = node.getMappedPort(3000)
    return newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${port}/rpc`)
  }

  it(
    'Simple Peering: A <-> B propagation',
    async () => {
      const clientA = getClient(nodeA)
      const clientB = getClient(nodeB)

      // 1. Linear Peering: A <-> B
      console.log('Establishing peering A <-> B')
      const netAResult = (await clientA.getNetworkClient('valid-secret')) as {
        success: true
        client: NetworkClient
      }
      const netBResult = (await clientB.getNetworkClient('valid-secret')) as {
        success: true
        client: NetworkClient
      }

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

      // Wait for handshake
      console.log('Waiting for peering A <-> B to resolve...')
      const waitForConnected = async (client: RpcStub<PublicApi>, peerName: string) => {
        for (let i = 0; i < 20; i++) {
          const netResult = await client.getNetworkClient('valid-secret')
          if (!netResult.success) throw new Error('Failed to get network client for check')
          const peers = await netResult.client.listPeers()
          const peer = peers.find((p) => p.name === peerName)
          if (peer && peer.connectionStatus === 'connected') return
          await new Promise((r) => setTimeout(r, 500))
        }
        throw new Error(`Peer ${peerName} failed to connect`)
      }
      await waitForConnected(clientA, 'node-b.somebiz.local.io')
      await waitForConnected(clientB, 'node-a.somebiz.local.io')

      // 2. A adds a local route
      console.log('Node A adding local route')
      const dataAResult = await clientA.getDataCustodianClient('valid-secret')
      if (!dataAResult.success) throw new Error('Failed to get data client')

      const routeResult = await dataAResult.client.addRoute({
        name: 'service-a',
        protocol: 'http',
        endpoint: 'http://a:8080',
      })

      if (!routeResult.success) {
        console.error('Route create failed:', routeResult)
        throw new Error(`Route create failed: ${routeResult.error || 'Unknown error'}`)
      }

      // Check B learned it
      let learnedOnB = false
      for (let i = 0; i < 40; i++) {
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
})
