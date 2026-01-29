import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import path from 'path'
import type { Readable } from 'node:stream'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from '../src/orchestrator.js'

const containerRuntime = process.env.CONTAINER_RUNTIME || 'docker'
const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED
if (skipTests) {
  console.warn('Skipping container tests: CATALYST_CONTAINER_TESTS_ENABLED not set')
}

describe.skipIf(skipTests)('Orchestrator Gateway Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes

  let network: StartedNetwork
  let gateway: StartedTestContainer
  let peerA: StartedTestContainer
  let peerB: StartedTestContainer
  let books: StartedTestContainer
  const peerBLogs: string[] = []

  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const gatewayImage = 'catalyst-gateway:test'
  const booksImage = 'catalyst-example-books:test'
  const repoRoot = path.resolve(__dirname, '../../../')

  beforeAll(async () => {
    // Build images (rely on cache)
    console.log('Building Gateway image...')
    const gatewayBuild = Bun.spawnSync(
      [containerRuntime, 'build', '-f', 'packages/gateway/Dockerfile', '-t', gatewayImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (gatewayBuild.exitCode !== 0) {
      throw new Error(`${containerRuntime} build gateway failed: ${gatewayBuild.exitCode}`)
    }

    if (gatewayBuild.exitCode !== 0) {
      throw new Error(`${containerRuntime} build gateway failed: ${gatewayBuild.exitCode}`)
    }

    console.log('Building Books service image...')
    const booksBuild = Bun.spawnSync(
      [
        containerRuntime,
        'build',
        '-f',
        'packages/examples/Dockerfile.books',
        '-t',
        booksImage,
        '.',
      ],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (booksBuild.exitCode !== 0) {
      throw new Error(`${containerRuntime} build books failed: ${booksBuild.exitCode}`)
    }

    console.log('Building Orchestrator image...')
    const orchestratorBuild = Bun.spawnSync(
      [
        containerRuntime,
        'build',
        '-f',
        'packages/orchestrator/Dockerfile',
        '-t',
        orchestratorImage,
        '.',
      ],
      // ['build', '-f', 'packages/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (orchestratorBuild.exitCode !== 0) {
      throw new Error(
        `${containerRuntime} build orchestrator failed: ${orchestratorBuild.exitCode}`
      )
    }

    network = await new Network().start()

    const startContainer = async (
      name: string,
      alias: string,
      waitMsg: string,
      env: Record<string, string> = {},
      ports: number[] = []
    ) => {
      let image = orchestratorImage
      if (alias === 'gateway') image = gatewayImage
      if (alias === 'books') image = booksImage

      let container = new GenericContainer(image)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withWaitStrategy(Wait.forLogMessage(waitMsg))
        .withLogConsumer((stream: Readable) => {
          stream.pipe(process.stdout)
          stream.on('data', (data: Buffer | string) => {
            if (alias === 'peer-b') {
              peerBLogs.push(data.toString())
            }
          })
        })

      if (ports.length > 0) {
        ports.forEach((p) => (container = container.withExposedPorts(p)))
      }
      if (Object.keys(env).length > 0) {
        container = container.withEnvironment(env)
      }
      return await container.start()
    }

    gateway = await startContainer('gateway', 'gateway', 'GATEWAY_STARTED', {}, [4000])

    const nodeEnv = (name: string, alias: string, gq: string = '') => ({
      PORT: '3000',
      CATALYST_NODE_ID: name,
      CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
      CATALYST_DOMAINS: 'somebiz.local.io',
      CATALYST_PEERING_SECRET: 'valid-secret',
      CATALYST_GQL_GATEWAY_ENDPOINT: gq,
    })

    peerA = await startContainer(
      'peer-a.somebiz.local.io',
      'peer-a',
      'NEXT_ORCHESTRATOR_STARTED',
      nodeEnv('peer-a.somebiz.local.io', 'peer-a'),
      [3000]
    )
    peerB = await startContainer(
      'peer-b.somebiz.local.io',
      'peer-b',
      'NEXT_ORCHESTRATOR_STARTED',
      nodeEnv('peer-b.somebiz.local.io', 'peer-b', 'ws://gateway:4000/api'),
      [3000]
    )
    books = await startContainer('books', 'books', 'BOOKS_STARTED', {}, [8080])

    console.log('Containers started')
  }, TIMEOUT)

  afterAll(async () => {
    console.log('Teardown: Starting...')
    try {
      if (peerA) await peerA.stop()
      if (peerB) await peerB.stop()
      if (books) await books.stop()
      if (gateway) await gateway.stop()
      if (network) await network.stop()
      console.log('Teardown: Success')
    } catch (e) {
      console.error('Teardown error', e)
    }
  }, TIMEOUT)

  it(
    'Mesh-wide GraphQL Sync: A -> B -> Gateway',
    async () => {
      console.log('Inside Mesh-wide Sync test')
      const portA = peerA.getMappedPort(3000)
      const clientA = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portA}/rpc`)

      const portB = peerB.getMappedPort(3000)
      const clientB = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portB}/rpc`)

      const netAResult = await clientA.getNetworkClient('valid-secret')
      const netBResult = await clientB.getNetworkClient('valid-secret')

      if (!netAResult.success || !netBResult.success) {
        throw new Error('Failed to get network client')
      }

      const netA = netAResult.client
      const netB = netBResult.client

      // 1. Peer A and B
      console.log('Peering nodes A and B...')
      await netB.addPeer({
        name: 'peer-a.somebiz.local.io',
        endpoint: 'ws://peer-a:3000/rpc',
        domains: ['somebiz.local.io'],
      })
      await netA.addPeer({
        name: 'peer-b.somebiz.local.io',
        endpoint: 'ws://peer-b:3000/rpc',
        domains: ['somebiz.local.io'],
      })

      // Give it a moment for the handshake
      console.log('Waiting for handshake...')
      await new Promise((r) => setTimeout(r, 2000))

      // 2. A adds a GraphQL route
      console.log('Adding GraphQL route to A...')
      const dataAResult = await clientA.getDataChannelClient('valid-secret')
      if (!dataAResult.success) throw new Error(`Failed to get data client: ${dataAResult.error}`)

      await dataAResult.client.addRoute({
        name: 'books-mesh',
        endpoint: 'http://books:8080/graphql',
        protocol: 'http:graphql',
      })

      console.log('Waiting for Gateway sync on Peer B...')
      let sawSync = false
      for (let i = 0; i < 30; i++) {
        if (peerBLogs.some((l) => l.includes('Gateway sync successful'))) {
          sawSync = true
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (!sawSync) {
        console.log(
          'Peer B Logs during failure (count: ' + peerBLogs.length + '):',
          peerBLogs.join('\n')
        )
      }
      expect(sawSync).toBe(true)
    },
    TIMEOUT
  )
})
