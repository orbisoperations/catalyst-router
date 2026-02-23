import { describe, it, expect, beforeEach } from 'vitest'
import { CatalystNodeBus, type NetworkClient, type DataChannel } from '../../src/orchestrator.js'
import { newRouteTable, type PeerInfo, type RouteTable } from '@catalyst/routing'
import { MockConnectionPool } from '../helpers/mock-connection-pool.js'

describe('Orchestrator Peering Tests (Mocked Container Logic)', () => {
  let pool: MockConnectionPool
  let nodeA: CatalystNodeBus
  let nodeB: CatalystNodeBus

  const infoA: PeerInfo = {
    name: 'node-a.somebiz.local.io',
    endpoint: 'ws://node-a',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-a',
  }
  const infoB: PeerInfo = {
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://node-b',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-b',
  }

  beforeEach(() => {
    pool = new MockConnectionPool()

    const createNode = (info: PeerInfo) => {
      const bus = new CatalystNodeBus({
        config: { node: info },
        connectionPool: { pool },
        state: newRouteTable(),
      })
      pool.registerNode(bus)
      return bus
    }

    nodeA = createNode(infoA)
    nodeB = createNode(infoB)
  })

  const waitForNotification = async (node: CatalystNodeBus) => {
    if ((node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise
    }
  }

  it('Routes registered before peering propagate bidirectionally', async () => {
    // Regression: when routes exist before peering is established, the
    // sync-on-connect code path in InternalProtocolOpen/Connected must
    // push pre-existing routes to the new peer in both directions.
    const apiA = nodeA.publicApi()
    const apiB = nodeB.publicApi()

    const netA = (
      (await apiA.getNetworkClient('secret')) as { success: true; client: NetworkClient }
    ).client
    const netB = (
      (await apiB.getNetworkClient('secret')) as { success: true; client: NetworkClient }
    ).client

    // 1. Register routes BEFORE peering
    const dataA = (
      (await apiA.getDataChannelClient('secret')) as { success: true; client: DataChannel }
    ).client
    const dataB = (
      (await apiB.getDataChannelClient('secret')) as { success: true; client: DataChannel }
    ).client

    await dataA.addRoute({ name: 'books-a', protocol: 'http' as const, endpoint: 'http://a:8080' })
    await dataB.addRoute({ name: 'books-b', protocol: 'http' as const, endpoint: 'http://b:8080' })

    // 2. Establish peering (B adds A first, then A adds B)
    await netB.addPeer(infoA)
    await netA.addPeer(infoB)

    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 100))

    // 3. Both sides should have learned the other's route
    const stateA = (nodeA as unknown as { state: RouteTable }).state
    const stateB = (nodeB as unknown as { state: RouteTable }).state

    const booksB_onA = stateA.internal.routes.find((r) => r.name === 'books-b')
    expect(booksB_onA).toBeDefined()
    expect(booksB_onA?.nodePath).toEqual(['node-b.somebiz.local.io'])

    const booksA_onB = stateB.internal.routes.find((r) => r.name === 'books-a')
    expect(booksA_onB).toBeDefined()
    expect(booksA_onB?.nodePath).toEqual(['node-a.somebiz.local.io'])
  })

  it('Simple Peering: A <-> B propagation', async () => {
    // 1. Establish Peering
    const apiA = nodeA.publicApi()
    const apiB = nodeB.publicApi()

    const netAResult = await apiA.getNetworkClient('secret')
    const netBResult = await apiB.getNetworkClient('secret')

    expect(netAResult.success).toBe(true)
    expect(netBResult.success).toBe(true)

    const netA = (netAResult as { success: true; client: NetworkClient }).client
    const netB = (netBResult as { success: true; client: NetworkClient }).client

    console.log('Node B adding peer A')
    await netB.addPeer(infoA)

    console.log('Node A adding peer B')
    await netA.addPeer(infoB)

    // Wait for handshake
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)

    // Additional wait to ensure bidirectional sync
    await new Promise((r) => setTimeout(r, 50))

    // Verify connection status
    const stateA = (nodeA as unknown as { state: RouteTable }).state
    const peerB = stateA.internal.peers.find((p) => p.name === infoB.name)
    expect(peerB?.connectionStatus).toBe('connected')

    const stateB = (nodeB as unknown as { state: RouteTable }).state
    const peerA = stateB.internal.peers.find((p) => p.name === infoA.name)
    expect(peerA?.connectionStatus).toBe('connected')

    // 2. A adds a local route
    console.log('Node A adding local route')
    const routeA = { name: 'service-a', protocol: 'http' as const, endpoint: 'http://a:8080' }
    const dataA = (
      (await apiA.getDataChannelClient('secret')) as { success: true; client: DataChannel }
    ).client
    await dataA.addRoute(routeA)

    // Wait for propagation
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // Check B learned it
    const stateB_After = (nodeB as unknown as { state: RouteTable }).state
    const learnedRoute = stateB_After.internal.routes.find((r) => r.name === 'service-a')

    expect(learnedRoute).toBeDefined()
    expect(learnedRoute?.nodePath).toEqual(['node-a.somebiz.local.io'])
  })

  it('addPeer rejects when peerToken is missing', async () => {
    const apiA = nodeA.publicApi()
    const netAResult = await apiA.getNetworkClient('secret')
    expect(netAResult.success).toBe(true)

    const netA = (netAResult as { success: true; client: NetworkClient }).client

    const result = await netA.addPeer({
      name: 'node-b.somebiz.local.io',
      endpoint: 'ws://node-b',
      domains: ['somebiz.local.io'],
      // peerToken intentionally omitted
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('peerToken is required')
    }
  })
})
