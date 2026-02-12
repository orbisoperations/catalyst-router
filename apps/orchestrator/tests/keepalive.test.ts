import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { CatalystNodeBus, type NetworkClient, type DataChannel } from '../src/orchestrator.js'
import { Actions, newRouteTable, type PeerInfo, type RouteTable } from '@catalyst/routing'
import { MockConnectionPool } from './mock-connection-pool.js'

const waitForNotification = async (node: CatalystNodeBus) => {
  if ((node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise) {
    await (node as unknown as { lastNotificationPromise?: Promise<void> }).lastNotificationPromise
  }
}

const getState = (node: CatalystNodeBus): RouteTable => {
  return (node as unknown as { state: RouteTable }).state
}

const setLastMessageReceived = (node: CatalystNodeBus, peerName: string, date: Date) => {
  const state = getState(node)
  const newState = {
    ...state,
    internal: {
      ...state.internal,
      peers: state.internal.peers.map((p) =>
        p.name === peerName ? { ...p, lastMessageReceived: date } : p
      ),
    },
  }
  ;(node as unknown as { state: RouteTable }).state = newState
}

describe('Keep-alive, peer expiry, and reconnection', () => {
  let pool: MockConnectionPool
  let nodeA: CatalystNodeBus
  let nodeB: CatalystNodeBus
  let nodeC: CatalystNodeBus

  const infoA: PeerInfo = {
    name: 'node-a.somebiz.local.io',
    endpoint: 'ws://node-a',
    domains: ['somebiz.local.io'],
  }
  const infoB: PeerInfo = {
    name: 'node-b.somebiz.local.io',
    endpoint: 'ws://node-b',
    domains: ['somebiz.local.io'],
  }
  const infoC: PeerInfo = {
    name: 'node-c.somebiz.local.io',
    endpoint: 'ws://node-c',
    domains: ['somebiz.local.io'],
  }

  const createNode = (info: PeerInfo, p: MockConnectionPool, holdTime?: number) => {
    const bus = new CatalystNodeBus({
      config: { node: info },
      connectionPool: { pool: p },
      state: newRouteTable(),
      holdTime: holdTime ?? 5,
    })
    p.registerNode(bus)
    return bus
  }

  const connectTwoNodes = async (
    a: CatalystNodeBus,
    b: CatalystNodeBus,
    peerInfoA: PeerInfo,
    peerInfoB: PeerInfo
  ) => {
    const apiA = a.publicApi()
    const apiB = b.publicApi()

    const netA = (
      (await apiA.getNetworkClient('secret')) as { success: true; client: NetworkClient }
    ).client
    const netB = (
      (await apiB.getNetworkClient('secret')) as { success: true; client: NetworkClient }
    ).client

    await netB.addPeer(peerInfoA)
    await netA.addPeer(peerInfoB)

    await waitForNotification(a)
    await waitForNotification(b)
    await new Promise((r) => setTimeout(r, 50))
  }

  beforeEach(() => {
    pool = new MockConnectionPool()
    nodeA = createNode(infoA, pool)
    nodeB = createNode(infoB, pool)
    nodeC = createNode(infoC, pool)
  })

  afterEach(() => {
    nodeA.stop()
    nodeB.stop()
    nodeC.stop()
  })

  it('keepalive message updates lastMessageReceived', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Verify connected
    const stateBBefore = getState(nodeB)
    const peerABefore = stateBBefore.internal.peers.find((p) => p.name === infoA.name)
    expect(peerABefore?.connectionStatus).toBe('connected')

    // Set lastMessageReceived to a known old time
    const oldTime = new Date(Date.now() - 2000)
    setLastMessageReceived(nodeB, infoA.name, oldTime)

    // Send keepalive from A to B
    const ibgpResult = await nodeB.publicApi().getIBGPClient('secret')
    expect(ibgpResult.success).toBe(true)
    const ibgpClient = (ibgpResult as { success: true; client: unknown }).client as {
      keepalive: (peer: PeerInfo) => Promise<unknown>
    }
    await ibgpClient.keepalive(infoA)
    await waitForNotification(nodeB)

    const stateBAfter = getState(nodeB)
    const peerAAfter = stateBAfter.internal.peers.find((p) => p.name === infoA.name)
    expect(peerAAfter?.lastMessageReceived).toBeDefined()
    expect(peerAAfter!.lastMessageReceived!.getTime()).toBeGreaterThan(oldTime.getTime())
  })

  it('hold timer expiry closes peer and withdraws routes', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Add a route on A and let it propagate to B
    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client
    await dataA.addRoute({
      name: 'service-a',
      protocol: 'http' as const,
      endpoint: 'http://a:8080',
    })
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // Verify B has the route
    let stateB = getState(nodeB)
    expect(stateB.internal.routes.find((r) => r.name === 'service-a')).toBeDefined()

    // Set A's lastMessageReceived to 200 seconds ago on node B (well past 5s hold time)
    const expiredTime = new Date(Date.now() - 200_000)
    setLastMessageReceived(nodeB, infoA.name, expiredTime)

    // Dispatch tick on B
    await nodeB.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // Verify peer A is closed on B
    stateB = getState(nodeB)
    const peerA = stateB.internal.peers.find((p) => p.name === infoA.name)
    expect(peerA?.connectionStatus).toBe('degraded')

    // Verify routes from A are withdrawn on B
    const routeFromA = stateB.internal.routes.find((r) => r.name === 'service-a')
    expect(routeFromA).toBeUndefined()
  })

  it('keepalive prevents hold timer expiry', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Set lastMessageReceived to a recent time (1 second ago, well within 5s hold time)
    const recentTime = new Date(Date.now() - 1000)
    setLastMessageReceived(nodeB, infoA.name, recentTime)

    // Dispatch tick
    await nodeB.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeB)

    // Peer should still be connected
    const stateB = getState(nodeB)
    const peerA = stateB.internal.peers.find((p) => p.name === infoA.name)
    expect(peerA?.connectionStatus).toBe('connected')
  })

  it('tick triggers keepalive send when threshold exceeded', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Hold time is 5s, keepalive threshold is holdTime/3 = ~1.67s
    // Set lastMessageReceived to 2s ago (past threshold but not expired)
    const pastThreshold = new Date(Date.now() - 2000)
    setLastMessageReceived(nodeB, infoA.name, pastThreshold)

    // Record A's lastMessageReceived before tick
    const stateABefore = getState(nodeA)
    const peerBOnABefore = stateABefore.internal.peers.find((p) => p.name === infoB.name)
    const beforeTime = peerBOnABefore?.lastMessageReceived?.getTime() ?? 0

    // Dispatch tick on B -- this should send a keepalive to A
    await nodeB.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeB)
    await waitForNotification(nodeA)
    await new Promise((r) => setTimeout(r, 50))

    // On node A, verify that B's keepalive was received (lastMessageReceived updated)
    // The tick on B sends keepalive to A, which dispatches InternalProtocolKeepalive on A
    // updating A's record for B
    const stateAAfter = getState(nodeA)
    const peerBOnAAfter = stateAAfter.internal.peers.find((p) => p.name === infoB.name)
    expect(peerBOnAAfter?.lastMessageReceived).toBeDefined()
    expect(peerBOnAAfter!.lastMessageReceived!.getTime()).toBeGreaterThanOrEqual(beforeTime)
  })

  it('InternalProtocolClose with HOLD_TIMER_EXPIRED marks peer as degraded', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Add a route on A, propagate to B
    const dataA = (
      (await nodeA.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client
    await dataA.addRoute({
      name: 'service-x',
      protocol: 'http' as const,
      endpoint: 'http://x:8080',
    })
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // Verify B has the route
    let stateB = getState(nodeB)
    expect(stateB.internal.routes.find((r) => r.name === 'service-x')).toBeDefined()

    // Dispatch InternalProtocolClose on B for peer A
    await nodeB.dispatch({
      action: Actions.InternalProtocolClose,
      data: {
        peerInfo: infoA,
        code: 4,
        reason: 'Hold timer expired',
      },
    })
    await waitForNotification(nodeB)

    // Peer A should still be in B's peer list, but marked as closed
    stateB = getState(nodeB)
    const peerA = stateB.internal.peers.find((p) => p.name === infoA.name)
    expect(peerA).toBeDefined()
    expect(peerA?.connectionStatus).toBe('degraded')

    // Routes from A should be removed
    const routeFromA = stateB.internal.routes.find((r) => r.name === 'service-x')
    expect(routeFromA).toBeUndefined()
  })

  it('tick reconnects degraded peers', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Verify B is connected on A
    let stateA = getState(nodeA)
    expect(stateA.internal.peers.find((p) => p.name === infoB.name)?.connectionStatus).toBe(
      'connected'
    )

    // Set B offline
    pool.setOffline(infoB.name)

    // Expire B's hold timer on A
    const expiredTime = new Date(Date.now() - 200_000)
    setLastMessageReceived(nodeA, infoB.name, expiredTime)

    // Dispatch tick to trigger expiry
    await nodeA.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeA)
    await new Promise((r) => setTimeout(r, 50))

    // Verify B is degraded on A (not closed - degraded means auto-reconnect)
    stateA = getState(nodeA)
    expect(stateA.internal.peers.find((p) => p.name === infoB.name)?.connectionStatus).toBe(
      'degraded'
    )

    // Bring B back online
    pool.setOnline(infoB.name)

    // Dispatch another tick to trigger reconnection
    await nodeA.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeA)
    await waitForNotification(nodeB)
    await new Promise((r) => setTimeout(r, 50))

    // Verify B is connected again on A
    stateA = getState(nodeA)
    expect(stateA.internal.peers.find((p) => p.name === infoB.name)?.connectionStatus).toBe(
      'connected'
    )
  })

  it('LocalPeerDelete fully removes peer from peer list', async () => {
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)

    // Verify B exists on A
    let stateA = getState(nodeA)
    expect(stateA.internal.peers.find((p) => p.name === infoB.name)).toBeDefined()

    // Delete peer B via LocalPeerDelete
    const netA = (
      (await nodeA.publicApi().getNetworkClient('secret')) as {
        success: true
        client: NetworkClient
      }
    ).client
    await netA.removePeer({ name: infoB.name })
    await waitForNotification(nodeA)

    // Verify B is completely gone from A's peer list
    stateA = getState(nodeA)
    const peerB = stateA.internal.peers.find((p) => p.name === infoB.name)
    expect(peerB).toBeUndefined()
  })

  it('multiple peers: one expires, others unaffected', async () => {
    // Connect A-B and A-C
    await connectTwoNodes(nodeA, nodeB, infoA, infoB)
    await connectTwoNodes(nodeA, nodeC, infoA, infoC)

    // Add a route on B and C, propagate to A
    const dataB = (
      (await nodeB.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client
    await dataB.addRoute({
      name: 'service-b',
      protocol: 'http' as const,
      endpoint: 'http://b:8080',
    })
    await waitForNotification(nodeB)
    await waitForNotification(nodeA)
    await new Promise((r) => setTimeout(r, 50))

    const dataC = (
      (await nodeC.publicApi().getDataChannelClient('secret')) as {
        success: true
        client: DataChannel
      }
    ).client
    await dataC.addRoute({
      name: 'service-c',
      protocol: 'http' as const,
      endpoint: 'http://c:8080',
    })
    await waitForNotification(nodeC)
    await waitForNotification(nodeA)
    await new Promise((r) => setTimeout(r, 50))

    // Verify A has both routes
    let stateA = getState(nodeA)
    expect(stateA.internal.routes.find((r) => r.name === 'service-b')).toBeDefined()
    expect(stateA.internal.routes.find((r) => r.name === 'service-c')).toBeDefined()

    // Expire only B on A
    const expiredTime = new Date(Date.now() - 200_000)
    setLastMessageReceived(nodeA, infoB.name, expiredTime)

    // Set C's lastMessageReceived to recent so it does not expire
    setLastMessageReceived(nodeA, infoC.name, new Date())

    // Dispatch tick
    await nodeA.dispatch({ action: Actions.InternalProtocolTick, data: {} })
    await waitForNotification(nodeA)
    await new Promise((r) => setTimeout(r, 50))

    // Verify B is degraded, C is still connected
    stateA = getState(nodeA)
    expect(stateA.internal.peers.find((p) => p.name === infoB.name)?.connectionStatus).toBe(
      'degraded'
    )
    expect(stateA.internal.peers.find((p) => p.name === infoC.name)?.connectionStatus).toBe(
      'connected'
    )

    // Verify B's routes are withdrawn, C's routes are intact
    expect(stateA.internal.routes.find((r) => r.name === 'service-b')).toBeUndefined()
    expect(stateA.internal.routes.find((r) => r.name === 'service-c')).toBeDefined()
  })
})
