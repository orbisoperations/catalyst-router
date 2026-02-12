import { describe, it, expect, beforeEach } from 'bun:test'
import { CatalystNodeBus, type NetworkClient, type DataChannel } from '../src/orchestrator.js'
import { newRouteTable, type PeerInfo, type RouteTable } from '@catalyst/routing'
import { MockConnectionPool } from './mock-connection-pool.js'

describe('Orchestrator Transit Tests (Mocked Container Logic)', () => {
  let pool: MockConnectionPool
  let nodeA: CatalystNodeBus
  let nodeB: CatalystNodeBus
  let nodeC: CatalystNodeBus

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
  const infoC: PeerInfo = {
    name: 'node-c.somebiz.local.io',
    endpoint: 'ws://node-c',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-c',
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
    nodeC = createNode(infoC)
  })

  const waitForNotification = async (node: CatalystNodeBus) => {
    if ((node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
      await (node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise
    }
  }

  it('Transit: A <-> B <-> C propagation', async () => {
    // 1. Establish Peering A <-> B
    const netA = (
      (await nodeA.publicApi().getNetworkClient('secret')) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netB = (
      (await nodeB.publicApi().getNetworkClient('secret')) as {
        success: true
        client: NetworkClient
      }
    ).client
    const netC = (
      (await nodeC.publicApi().getNetworkClient('secret')) as {
        success: true
        client: NetworkClient
      }
    ).client

    await netB.addPeer(infoA)
    await netA.addPeer(infoB)

    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // 2. Establish Peering B <-> C
    await netC.addPeer(infoB)
    await netB.addPeer(infoC)

    await waitForNotification(nodeB)
    await waitForNotification(nodeC)
    await new Promise((r) => setTimeout(r, 50))

    // 3. A adds local route
    console.log('Node A adding local route')
    const routeA = { name: 'service-a', protocol: 'http' as const, endpoint: 'http://a:8080' }
    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client
    await dataA.addRoute(routeA)

    // Wait for propagation to B and then C
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await waitForNotification(nodeC)
    // Extra padding for chained events
    await new Promise((r) => setTimeout(r, 100))

    // Check C learned it via B
    const stateC = (nodeC as unknown as { state: RouteTable }).state
    const learnedRoute = stateC.internal.routes.find((r) => r.name === 'service-a')

    expect(learnedRoute).toBeDefined()
    expect(learnedRoute?.nodePath).toEqual(['node-b.somebiz.local.io', 'node-a.somebiz.local.io'])

    // 4. Withdrawal Propagation
    console.log('Node A deleting route')
    await (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client.removeRoute(routeA)

    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await waitForNotification(nodeC)
    await new Promise((r) => setTimeout(r, 100))

    const stateC_AfterWithdraw = (nodeC as unknown as { state: RouteTable }).state
    const hasRoute = stateC_AfterWithdraw.internal.routes.some((r) => r.name === 'service-a')
    expect(hasRoute).toBe(false)

    // 5. Disconnect Propagation
    // Re-add route
    await (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client.addRoute(routeA)
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await waitForNotification(nodeC)
    await new Promise((r) => setTimeout(r, 100))

    // Verify C has it again
    expect(
      (nodeC as unknown as { state: RouteTable }).state.internal.routes.some(
        (r) => r.name === 'service-a'
      )
    ).toBe(true)

    // Disconnect A from B
    console.log('Disconnecting A from B')
    await netA.removePeer({ name: infoB.name })

    // This triggers B to close session, which triggers B to update C
    await waitForNotification(nodeA)
    // Wait for B's reaction
    await new Promise((r) => setTimeout(r, 200))

    const stateC_AfterDisconnect = (nodeC as unknown as { state: RouteTable }).state
    const hasRouteFinal = stateC_AfterDisconnect.internal.routes.some((r) => r.name === 'service-a')
    expect(hasRouteFinal).toBe(false)
  })
})
