import { describe, it, expect, beforeEach } from 'vitest'
import { CatalystNodeBus, type NetworkClient, type DataChannel } from '../../src/orchestrator.js'
import { newRouteTable, type PeerInfo, type RouteTable } from '@catalyst/routing'

import { MockConnectionPool } from '../helpers/mock-connection-pool.js'

describe('Orchestrator Topology Tests', () => {
  let pool: MockConnectionPool
  let nodeA: CatalystNodeBus
  let nodeB: CatalystNodeBus
  let nodeC: CatalystNodeBus

  const infoA = {
    name: 'node-a.somebiz.local.io',
    endpoint: 'ws://node-a',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-a',
  } satisfies PeerInfo
  const infoB = {
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://node-b',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-b',
  } satisfies PeerInfo
  const infoC = {
    name: 'node-c.somebiz.local.io',
    endpoint: 'ws://node-c',
    domains: ['somebiz.local.io'],
    peerToken: 'token-for-c',
  } satisfies PeerInfo

  beforeEach(() => {
    pool = new MockConnectionPool()

    const createNode = (info: PeerInfo & { endpoint: string }) => {
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

  it('Linear Topology: A <-> B <-> C propagation and withdrawal', async () => {
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

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
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
    await new Promise((r) => setTimeout(r, 100))

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

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
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

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
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
    await new Promise((r) => setTimeout(r, 100))

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
  })

  it('Loop Prevention: A -> B -> C -> A', async () => {
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

    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
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
