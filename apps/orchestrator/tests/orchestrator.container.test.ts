import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'

import path from 'path'
import type { Readable } from 'node:stream'
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import type { PublicApi, PeerInfo } from '../src/orchestrator'
import { Actions } from '@catalyst/routing'

import path from 'path'
import type { PeerInfo, PublicApi } from '../src/orchestrator'
import { CatalystNodeBus, ConnectionPool } from '../src/orchestrator'

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

  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const authImage = 'catalyst-auth:next-topology-e2e'

  beforeAll(async () => {
    const repoRoot = path.resolve(__dirname, '../../../')

    const buildImage = async (dockerfilePath: string, imageName: string) => {
      console.log(`Building ${imageName} image for Container tests...`)
      const buildResult = Bun.spawnSync(
        ['docker', 'build', '-f', dockerfilePath, '-t', imageName, '.'],
        { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
      )
      if (buildResult.exitCode !== 0) throw new Error(`Docker build ${imageName} failed`)
    }

    await buildImage('apps/orchestrator/Dockerfile', orchestratorImage)
    await buildImage('apps/auth/Dockerfile', authImage)

    network = await new Network().start()

    // Start auth service first
    console.log('Starting auth service...')
    const authLogs: string[] = []
    auth = await new GenericContainer(authImage)
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
      return await new GenericContainer(orchestratorImage)
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

const MOCK_NODE: PeerInfo = {
  name: 'node-a.somebiz.local.io',
  endpoint: 'http://node-a:3000',
  domains: ['somebiz.local.io'],
}

const GATEWAY_ENDPOINT = 'http://gateway:4000'

interface GatewayService {
  name: string
  url: string
}

interface GatewayConfig {
  services: GatewayService[]
}

class MockConnectionPool extends ConnectionPool {
  public calls: { endpoint: string; config: GatewayConfig }[] = []
  public mockStubs: Map<string, Record<string, unknown>> = new Map()

  get(endpoint: string) {
    if (!this.mockStubs.has(endpoint)) {
      const stub = {
        updateConfig: vi.fn(async (config: GatewayConfig) => {
          this.calls.push({ endpoint, config })
          return { success: true }
        }),
        getIBGPClient: vi.fn(async () => ({
          success: true,
          client: {
            update: vi.fn(async () => ({ success: true })),
            open: vi.fn(async () => ({ success: true })),
          },
        })),
      }
      this.mockStubs.set(endpoint, stub as Record<string, unknown>)
    }
    return this.mockStubs.get(endpoint) as unknown as RpcStub<PublicApi>
  }
}

describe('CatalystNodeBus > GraphQL Gateway Sync', () => {
  let bus: CatalystNodeBus
  let pool: MockConnectionPool

  beforeEach(() => {
    pool = new MockConnectionPool('http')
    bus = new CatalystNodeBus({
      config: {
        node: MOCK_NODE,
        gqlGatewayConfig: { endpoint: GATEWAY_ENDPOINT },
      },
      connectionPool: { pool },
    })
  })

  it('should sync local GraphQL routes to gateway', async () => {
    const route = {
      name: 'books',
      protocol: 'http:graphql' as const,
      endpoint: 'http://books:8080',
    }

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: route,
    })

    // Give some time for async handleNotify/syncGateway
    await new Promise((r) => setTimeout(r, 10))

    expect(pool.calls.length).toBe(1)
    expect(pool.calls[0].endpoint).toBe(GATEWAY_ENDPOINT)
    expect(pool.calls[0].config.services).toEqual([{ name: 'books', url: 'http://books:8080' }])
  })

  it('should NOT sync non-GraphQL routes', async () => {
    const route = {
      name: 'grpc-service',
      protocol: 'http:grpc' as const,
      endpoint: 'http://grpc:5000',
    }

    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: route,
    })

    await new Promise((r) => setTimeout(r, 10))

    // console.log('Calls:', JSON.stringify(pool.calls));
    // It shouldn't trigger sync if no graphql routes exist
    // Or it might trigger but find 0 routes.
    // In my impl, I added a check: if (graphqlRoutes.length === 0) return
    expect(pool.calls.length).toBe(0)
  })

  it('should sync mesh-wide GraphQL routes (local + internal)', async () => {
    // 1. Add local route
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'local-books', protocol: 'http:graphql', endpoint: 'http://lb:8080' },
    })

    // 2. Add internal route (from peer)
    const peerInfo: PeerInfo = {
      name: 'peer-b.somebiz.local.io',
      endpoint: 'http://pb',
      domains: [],
    }
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: { name: 'remote-movies', protocol: 'http:gql', endpoint: 'http://rm:8080' },
              nodePath: ['peer-b.somebiz.local.io'],
            },
          ],
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    // Expect 2 calls (one for each action)
    expect(pool.calls.length).toBe(2)
    const lastSync = pool.calls[1].config.services
    expect(lastSync).toHaveLength(2)
    expect(lastSync).toContainEqual({ name: 'local-books', url: 'http://lb:8080' })
    expect(lastSync).toContainEqual({ name: 'remote-movies', url: 'http://rm:8080' })
  })
})
