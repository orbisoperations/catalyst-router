import { newRouteTable, type PeerInfo, type RouteTable } from '@catalyst/routing'
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import path from 'path'
import { CatalystNodeBus, type DataChannel, type NetworkClient } from '../src/orchestrator.js'

import { Network } from 'testcontainers'
import {
  mintDataCustodianToken,
  mintNodeCustodianToken,
  mintPeerToken,
  startAuthService,
} from './auth-test-helpers.js'
import { MockConnectionPool } from './mock-connection-pool.js'

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
  console.warn('Skipping topology tests: Docker is not running')
}

describe.skipIf(skipTests)('Orchestrator Topology Tests', () => {
  let pool: MockConnectionPool
  let nodeA: CatalystNodeBus
  let nodeB: CatalystNodeBus
  let nodeC: CatalystNodeBus

  const infoA = {
    name: 'node-a.somebiz.local.io',
    endpoint: 'ws://node-a',
    domains: ['somebiz.local.io'],
  } satisfies PeerInfo
  const infoB = {
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://node-b',
    domains: ['somebiz.local.io'],
  } satisfies PeerInfo
  const infoC = {
    name: 'node-c.somebiz.local.io',
    endpoint: 'ws://node-c',
    domains: ['somebiz.local.io'],
  } satisfies PeerInfo

  const repoRoot = path.resolve(__dirname, '../../../')
  const authImage = 'catalyst-auth'

  const buildImages = async () => {
    // check if auth image is built
    console.log('Building Auth image...')
    const authBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/auth/Dockerfile', '-t', authImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (authBuild.exitCode !== 0) {
      throw new Error(`docker build auth failed: ${authBuild.exitCode}`)
    }
  }

  let nodeCustodianToken: string = ''
  let dataCustodianToken: string = ''
  let authHostUrl: string = ''
  // NODE principal tokens for each node (used internally for IBGP communication)
  let nodeTokenA: string = ''
  let nodeTokenB: string = ''
  let nodeTokenC: string = ''

  beforeAll(async () => {
    await buildImages()
    const network = await new Network().start()
    const auth = await startAuthService(network, 'auth', authImage)

    authHostUrl = `ws://${auth.container.getHost()}:${auth.container.getFirstMappedPort()}/rpc`

    // Mint NODE_CUSTODIAN token for peer operations (addPeer, removePeer, etc.)
    nodeCustodianToken = await mintNodeCustodianToken(
      authHostUrl,
      auth.systemToken,
      infoA.name,
      infoA.domains
    )

    // Mint DATA_CUSTODIAN token for route operations (addRoute, removeRoute, etc.)
    dataCustodianToken = await mintDataCustodianToken(
      authHostUrl,
      auth.systemToken,
      infoA.name,
      infoA.domains
    )

    // Mint NODE tokens for each node (used for IBGP inter-node communication)
    nodeTokenA = await mintPeerToken(authHostUrl, auth.systemToken, infoA.name, infoA.domains)
    nodeTokenB = await mintPeerToken(authHostUrl, auth.systemToken, infoB.name, infoB.domains)
    nodeTokenC = await mintPeerToken(authHostUrl, auth.systemToken, infoC.name, infoC.domains)
  })

  beforeEach(async () => {
    pool = new MockConnectionPool()

    const createNode = (info: PeerInfo & { endpoint: string }, nodeToken: string) => {
      const bus = new CatalystNodeBus({
        config: { node: info },
        connectionPool: { pool },
        state: newRouteTable(),
        authEndpoint: authHostUrl,
        nodeToken,
      })
      pool.registerNode(bus)
      return bus
    }

    nodeA = createNode(infoA, nodeTokenA)
    nodeB = createNode(infoB, nodeTokenB)
    nodeC = createNode(infoC, nodeTokenC)
  })

  it('Linear Topology: A <-> B <-> C propagation and withdrawal', async () => {
    const netA = (
      (await nodeA.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netB = (
      (await nodeB.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netC = (
      (await nodeC.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient(dataCustodianToken)) as {
        success: true
        client: DataChannel
      }
    ).client

    // 1. Peer A to B
    await netA.addPeer(infoB)
    await netB.addPeer(infoA)

    // 2. Peer B to C
    await netB.addPeer(infoC)
    await netC.addPeer(infoB)

    // 3. A adds local route
    const routeA = { name: 'service-a', protocol: 'http' as const, endpoint: 'http://a:8080' }
    await dataA.addRoute(routeA)

    // Wait for propagation (async side-effects)
    await new Promise((r) => setTimeout(r, 700))

    // Check B learned it
    const stateB = (nodeB as unknown as { state: RouteTable }).state
    expect(stateB.internal.routes.some((r) => r.name === 'service-a')).toBe(true)

    // Check C learned it
    const stateC = (nodeC as unknown as { state: RouteTable }).state
    const routeOnC = stateC.internal.routes.find((r) => r.name === 'service-a')
    expect(routeOnC).toBeDefined()
    expect(routeOnC?.nodePath).toEqual(['node-b.somebiz.local.io', 'node-a.somebiz.local.io'])

    // 4. A withdraws route
    await dataA.removeRoute(routeA)
    await new Promise((r) => setTimeout(r, 100))

    // B and C should have removed it
    expect(
      (nodeB as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'service-a'
      )
    ).toBe(false)
    expect(
      (nodeC as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'service-a'
      )
    ).toBe(false)
  })

  it('Initial Sync: B learns A, then C connects to B -> C should learn A', async () => {
    const netA = (
      (await nodeA.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    expect(netA).toBeDefined()
    const netB = (
      (await nodeB.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netC = (
      (await nodeC.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient(dataCustodianToken)) as {
        success: true
        client: DataChannel
      }
    ).client

    // 1. B Peers with A
    await netA.addPeer(infoB)
    await netB.addPeer(infoA)

    // Wait for peering to establish
    if ((nodeA as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (nodeA as unknown as { lastNotificationPromise?: Promise<void> })
        .lastNotificationPromise
    }
    if ((nodeB as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (nodeB as unknown as { lastNotificationPromise?: Promise<void> })
        .lastNotificationPromise
    }

    // 2. A adds route
    const routeA = { name: 'service-a', protocol: 'http' as const, endpoint: 'http://a:8080' }
    await dataA.addRoute(routeA)

    // Wait for propagation
    if ((nodeA as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (nodeA as unknown as { lastNotificationPromise?: Promise<void> })
        .lastNotificationPromise
    }

    // Give B time to process the update received from A
    if ((nodeB as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (nodeB as unknown as { lastNotificationPromise?: Promise<void> })
        .lastNotificationPromise
    }

    expect(
      (nodeB as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'service-a'
      )
    ).toBe(true)

    // 3. NOW C connects to B
    await netB.addPeer(infoC)
    await netC.addPeer(infoB)

    await new Promise((r) => setTimeout(r, 100))

    // C should learn A's route via B (Initial Sync)
    const stateC = (nodeC as unknown as { state: RouteTable }).state
    const hasA = stateC.internal.routes.some((r) => r.name === 'service-a')

    expect(hasA).toBe(true)
  })

  it('Withdrawal on Disconnect: A <-> B <-> C. A disconnects from B -> C should remove A', async () => {
    const netA = (
      (await nodeA.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netB = (
      (await nodeB.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netC = (
      (await nodeC.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient(dataCustodianToken)) as {
        success: true
        client: DataChannel
      }
    ).client

    // 1. Setup A <-> B <-> C
    await netA.addPeer(infoB)
    await netB.addPeer(infoA)
    await netB.addPeer(infoC)
    await netC.addPeer(infoB)

    // 2. A adds route
    const routeA = { name: 'service-a', protocol: 'http' as const, endpoint: 'http://a:8080' }
    await dataA.addRoute(routeA)
    await new Promise((r) => setTimeout(r, 2000))

    expect(
      (nodeC as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'service-a'
      )
    ).toBe(true)

    // 3. B disconnects from A (or A from B)
    // We simulate A closing the connection to B
    await netA.removePeer({ name: infoB.name })

    // nodeA.LocalPeerDelete triggers nodeB.InternalProtocolClose
    await new Promise((r) => setTimeout(r, 150))

    // 4. C should have removed A's route because B told it to
    const hasAOnC = (nodeC as unknown as { state: RouteTable }).state.internal.routes.some(
      (r) => r.name === 'service-a'
    )
    expect(hasAOnC).toBe(false)
  }, 10000)

  it('Loop Prevention: A -> B -> C -> A', async () => {
    const netA = (
      (await nodeA.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netB = (
      (await nodeB.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netC = (
      (await nodeC.publicApi().getNetworkClient(nodeCustodianToken)) as {
        success: true
        client: NetworkClient
      }
    ).client

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient(dataCustodianToken)) as {
        success: true
        client: DataChannel
      }
    ).client

    // A -> B
    await netA.addPeer(infoB)
    await netB.addPeer(infoA)

    // B -> C
    await netB.addPeer(infoC)
    await netC.addPeer(infoB)

    // C -> A
    await netC.addPeer(infoA)
    await netA.addPeer(infoC)

    // A adds route
    const routeA = { name: 'loop-test', protocol: 'http' as const, endpoint: 'http://a:8080' }
    await dataA.addRoute(routeA)

    await new Promise((r) => setTimeout(r, 150))

    // A should have it in local
    expect(
      (nodeA as unknown as { state: RouteTable }).state.local.routes.some(
        (r) => r.name === 'loop-test'
      )
    ).toBe(true)

    // A should NOT have it in internal (despite C offering it)
    expect(
      (nodeA as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'loop-test'
      )
    ).toBe(false)
  })
})
