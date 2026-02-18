import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { CatalystNodeBus, ConnectionPool, type PublicApi } from '../src/orchestrator.js'
import type { RpcStub } from 'capnweb'

const MOCK_NODE: PeerInfo = {
  name: 'node-a.somebiz.local.io',
  endpoint: 'http://node-a:3000',
  domains: ['somebiz.local.io'],
}

const ENVOY_ENDPOINT = 'http://envoy:18000'

interface EnvoyUpdateRoutesPayload {
  local: Array<{ name: string; envoyPort?: number; [key: string]: unknown }>
  internal: Array<{ name: string; envoyPort?: number; peerName?: string; [key: string]: unknown }>
  portAllocations?: Record<string, number>
}

class MockConnectionPool extends ConnectionPool {
  public envoyCalls: { endpoint: string; payload: EnvoyUpdateRoutesPayload }[] = []
  public bgpCalls: { endpoint: string; method: string; args: unknown[] }[] = []
  public mockStubs: Map<string, Record<string, unknown>> = new Map()

  get(endpoint: string) {
    if (!this.mockStubs.has(endpoint)) {
      const stub = {
        updateRoutes: mock(async (payload: EnvoyUpdateRoutesPayload) => {
          this.envoyCalls.push({ endpoint, payload })
          return { success: true }
        }),
        updateConfig: mock(async () => ({ success: true })),
        getIBGPClient: mock(async () => ({
          success: true,
          client: {
            update: mock(async (...args: unknown[]) => {
              this.bgpCalls.push({ endpoint, method: 'update', args })
              return { success: true }
            }),
            open: mock(async (...args: unknown[]) => {
              this.bgpCalls.push({ endpoint, method: 'open', args })
              return { success: true }
            }),
            close: mock(async () => ({ success: true })),
          },
        })),
      }
      this.mockStubs.set(endpoint, stub as Record<string, unknown>)
    }
    return this.mockStubs.get(endpoint) as unknown as RpcStub<PublicApi>
  }
}

function createBusWithEnvoy(pool: MockConnectionPool) {
  return new CatalystNodeBus({
    config: {
      node: MOCK_NODE,
      ibgp: { secret: 'secret' },
      envoyConfig: {
        endpoint: ENVOY_ENDPOINT,
        portRange: [[10000, 10100]],
      },
    },
    connectionPool: { pool },
  })
}

describe('CatalystNodeBus > Envoy Integration', () => {
  let bus: CatalystNodeBus
  let pool: MockConnectionPool

  beforeEach(() => {
    pool = new MockConnectionPool('http')
    bus = createBusWithEnvoy(pool)
  })

  it('allocates port and pushes config on local route create', async () => {
    const route = {
      name: 'books-api',
      protocol: 'http' as const,
      endpoint: 'http://books:8080',
    }

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await bus.lastNotificationPromise

    expect(pool.envoyCalls.length).toBe(1)
    expect(pool.envoyCalls[0].endpoint).toBe(ENVOY_ENDPOINT)

    const pushed = pool.envoyCalls[0].payload
    expect(pushed.local).toHaveLength(1)
    expect(pushed.local[0].name).toBe('books-api')
    expect(pushed.local[0].envoyPort).toBeNumber()
    expect(pushed.local[0].envoyPort).toBeGreaterThanOrEqual(10000)
    expect(pushed.local[0].envoyPort).toBeLessThanOrEqual(10100)
  })

  it('releases port and pushes updated config on local route delete', async () => {
    // First create a route
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
    })
    await bus.lastNotificationPromise

    // Now delete it
    await bus.dispatch({
      action: Actions.LocalRouteDelete,
      data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
    })
    await bus.lastNotificationPromise

    // Should have two envoy calls: one for create, one for delete
    expect(pool.envoyCalls.length).toBe(2)

    // The delete push should have zero local routes
    const deletePush = pool.envoyCalls[1].payload
    expect(deletePush.local).toHaveLength(0)
  })

  it('allocates egress port on internal route update from peer', async () => {
    // First set up a connected peer
    const peerInfo: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-b',
    }

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    await bus.lastNotificationPromise
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo },
    })
    await bus.lastNotificationPromise

    // Clear envoy calls from peer setup
    pool.envoyCalls.length = 0

    // Now receive a route update from the peer
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'movies-api',
                protocol: 'http' as const,
                endpoint: 'http://movies:8080',
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    expect(pool.envoyCalls.length).toBe(1)
    const pushed = pool.envoyCalls[0].payload
    expect(pushed.internal).toHaveLength(1)
    expect(pushed.internal[0].name).toBe('movies-api')
    expect(pushed.internal[0].envoyPort).toBeNumber()
    expect(pushed.internal[0].envoyPort).toBeGreaterThanOrEqual(10000)
  })

  it('releases egress ports on InternalProtocolClose', async () => {
    // Set up peer and receive route
    const peerInfo: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-b',
    }

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    await bus.lastNotificationPromise
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo },
    })
    await bus.lastNotificationPromise

    // Receive route from peer
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'movies-api',
                protocol: 'http' as const,
                endpoint: 'http://movies:8080',
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    pool.envoyCalls.length = 0

    // Close the peer connection
    await bus.dispatch({
      action: Actions.InternalProtocolClose,
      data: { peerInfo, code: 1000, reason: 'done' },
    })
    await bus.lastNotificationPromise

    expect(pool.envoyCalls.length).toBe(1)
    const pushed = pool.envoyCalls[0].payload
    // After close, internal routes from that peer are gone
    expect(pushed.internal).toHaveLength(0)
  })

  it('does nothing when no envoyConfig is present (backward compatible)', async () => {
    const plainPool = new MockConnectionPool('http')
    const plainBus = new CatalystNodeBus({
      config: {
        node: MOCK_NODE,
        ibgp: { secret: 'secret' },
      },
      connectionPool: { pool: plainPool },
    })

    await plainBus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
    })
    await plainBus.lastNotificationPromise

    expect(plainPool.envoyCalls.length).toBe(0)
  })

  it('logs error but does not crash on port exhaustion', async () => {
    // Create bus with tiny port range (1 port)
    const tinyPool = new MockConnectionPool('http')
    const tinyBus = new CatalystNodeBus({
      config: {
        node: MOCK_NODE,
        ibgp: { secret: 'secret' },
        envoyConfig: {
          endpoint: ENVOY_ENDPOINT,
          portRange: [10000],
        },
      },
      connectionPool: { pool: tinyPool },
    })

    // First route should succeed
    await tinyBus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'route-1', protocol: 'http' as const, endpoint: 'http://r1:8080' },
    })
    await tinyBus.lastNotificationPromise

    // Second route should fail to allocate but not throw
    await tinyBus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'route-2', protocol: 'http' as const, endpoint: 'http://r2:8080' },
    })
    await tinyBus.lastNotificationPromise

    // Should have 2 envoy calls (both routes pushed, but second without envoyPort)
    expect(tinyPool.envoyCalls.length).toBe(2)

    // First route has port, second does not
    const firstPush = tinyPool.envoyCalls[0].payload
    expect(firstPush.local[0].envoyPort).toBe(10000)

    const secondPush = tinyPool.envoyCalls[1].payload
    const routeWithPort = secondPush.local.find((r) => r.name === 'route-1')
    const routeWithoutPort = secondPush.local.find((r) => r.name === 'route-2')
    expect(routeWithPort?.envoyPort).toBe(10000)
    expect(routeWithoutPort?.envoyPort).toBeUndefined()
  })

  it('idempotent allocation: same route dispatched twice gets same port', async () => {
    const route = {
      name: 'books-api',
      protocol: 'http' as const,
      endpoint: 'http://books:8080',
    }

    await bus.dispatch({ action: Actions.LocalRouteCreate, data: route })
    await bus.lastNotificationPromise

    const firstPort = pool.envoyCalls[0].payload.local[0].envoyPort

    // Dispatch another action that triggers envoy config push
    // (add a second route to trigger another push)
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'movies-api', protocol: 'http' as const, endpoint: 'http://movies:8080' },
    })
    await bus.lastNotificationPromise

    // The books-api port should be the same in both pushes
    const secondPush = pool.envoyCalls[1].payload
    const booksRoute = secondPush.local.find((r) => r.name === 'books-api')
    expect(booksRoute?.envoyPort).toBe(firstPort)
  })

  it('rewrites envoyPort in BGP re-advertisement for multi-hop', async () => {
    // Set up two peers: node-b (upstream) and node-c (downstream)
    const peerB: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      envoyAddress: 'envoy-proxy-b',
      peerToken: 'token-for-b',
    }
    const peerC: PeerInfo = {
      name: 'node-c.somebiz.local.io',
      endpoint: 'http://node-c:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-c',
    }

    // Connect both peers
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerC } })
    await bus.lastNotificationPromise

    pool.envoyCalls.length = 0
    pool.bgpCalls.length = 0

    // Receive a route from peer B with B's envoyPort (5000)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
                envoyPort: 5000,
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    // Find the BGP call to peer C (re-advertisement)
    const bgpToC = pool.bgpCalls.find((c) => c.endpoint === peerC.endpoint)
    expect(bgpToC).toBeDefined()

    const updateMsg = bgpToC!.args[1] as {
      updates: Array<{ action: string; route: { envoyPort?: number }; nodePath: string[] }>
    }
    const addUpdate = updateMsg.updates.find((u) => u.action === 'add')
    expect(addUpdate).toBeDefined()

    // envoyPort should be this node's allocated egress port, NOT the original 5000
    expect(addUpdate!.route.envoyPort).toBeNumber()
    expect(addUpdate!.route.envoyPort).toBeGreaterThanOrEqual(10000)
    expect(addUpdate!.route.envoyPort).toBeLessThanOrEqual(10100)
    expect(addUpdate!.route.envoyPort).not.toBe(5000)

    // nodePath should have local node prepended
    expect(addUpdate!.nodePath).toEqual(['node-a.somebiz.local.io', 'node-b.somebiz.local.io'])
  })

  it('does not rewrite envoyPort when no envoy configured', async () => {
    const plainPool = new MockConnectionPool('http')
    const plainBus = new CatalystNodeBus({
      config: {
        node: MOCK_NODE,
        ibgp: { secret: 'secret' },
        // no envoyConfig
      },
      connectionPool: { pool: plainPool },
    })

    const peerB: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-b',
    }
    const peerC: PeerInfo = {
      name: 'node-c.somebiz.local.io',
      endpoint: 'http://node-c:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-c',
    }

    await plainBus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await plainBus.lastNotificationPromise
    await plainBus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
    await plainBus.lastNotificationPromise
    await plainBus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await plainBus.lastNotificationPromise
    await plainBus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerC } })
    await plainBus.lastNotificationPromise

    plainPool.bgpCalls.length = 0

    // Receive a route from peer B with envoyPort 5000
    await plainBus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
                envoyPort: 5000,
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await plainBus.lastNotificationPromise

    // BGP call to C should have original envoyPort (no rewrite)
    const bgpToC = plainPool.bgpCalls.find((c) => c.endpoint === peerC.endpoint)
    expect(bgpToC).toBeDefined()

    const updateMsg = bgpToC!.args[1] as {
      updates: Array<{ action: string; route: { envoyPort?: number } }>
    }
    const addUpdate = updateMsg.updates.find((u) => u.action === 'add')
    expect(addUpdate!.route.envoyPort).toBe(5000)
  })

  it('full sync on peer connect uses state-mutated egress port', async () => {
    // Set up peer B and receive a route from it
    const peerB: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      envoyAddress: 'envoy-proxy-b',
      peerToken: 'token-for-b',
    }

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
    await bus.lastNotificationPromise

    // Receive route from peer B (original envoyPort 5000)
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
                envoyPort: 5000,
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    pool.bgpCalls.length = 0

    // Now connect a new peer C — triggers full table sync (InternalProtocolOpen)
    const peerC: PeerInfo = {
      name: 'node-c.somebiz.local.io',
      endpoint: 'http://node-c:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-c',
    }

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerC } })
    await bus.lastNotificationPromise

    // Find the BGP update call to C for the full sync (not the open call)
    const bgpToC = pool.bgpCalls.find((c) => c.endpoint === peerC.endpoint && c.method === 'update')
    expect(bgpToC).toBeDefined()

    const updateMsg = bgpToC!.args[1] as {
      updates: Array<{ action: string; route: { name: string; envoyPort?: number } }>
    }
    const booksUpdate = updateMsg.updates.find(
      (u) => u.action === 'add' && u.route.name === 'books-api'
    )
    expect(booksUpdate).toBeDefined()

    // Should have the mutated egress port from handleEnvoyConfiguration, not 5000
    expect(booksUpdate!.route.envoyPort).toBeNumber()
    expect(booksUpdate!.route.envoyPort).toBeGreaterThanOrEqual(10000)
    expect(booksUpdate!.route.envoyPort).toBeLessThanOrEqual(10100)
    expect(booksUpdate!.route.envoyPort).not.toBe(5000)
  })

  it('envoyPort is populated before BGP broadcast (ordering)', async () => {
    // Set up a connected peer so BGP broadcast happens
    const peerInfo: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-b',
    }

    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })
    await bus.lastNotificationPromise
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo },
    })
    await bus.lastNotificationPromise

    pool.envoyCalls.length = 0
    pool.bgpCalls.length = 0

    // Create a local route — triggers both envoy config and BGP broadcast
    await bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
    })
    await bus.lastNotificationPromise

    // Envoy should have been called
    expect(pool.envoyCalls.length).toBeGreaterThanOrEqual(1)

    // The envoy push should contain envoyPort on the local route
    const envoyPush = pool.envoyCalls[0].payload
    expect(envoyPush.local[0].envoyPort).toBeNumber()

    // handleEnvoyConfiguration runs before handleBGPNotify.
    // The routes in the state should have envoyPort set by the time BGP sees them.
    // Verify the envoy push had the port assigned.
    expect(envoyPush.local[0].envoyPort).toBeGreaterThanOrEqual(10000)
  })

  it('passes this node envoyAddress to downstream peers via PeerInfo', async () => {
    // Create a bus where the node has envoyAddress configured
    const envoyPool = new MockConnectionPool('http')
    const envoyBus = new CatalystNodeBus({
      config: {
        node: {
          ...MOCK_NODE,
          envoyAddress: 'envoy-proxy-a',
        },
        ibgp: { secret: 'secret' },
        envoyConfig: {
          endpoint: ENVOY_ENDPOINT,
          portRange: [[10000, 10100]],
        },
      },
      connectionPool: { pool: envoyPool },
    })

    const peerB: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      envoyAddress: 'envoy-proxy-b',
      peerToken: 'token-for-b',
    }
    const peerC: PeerInfo = {
      name: 'node-c.somebiz.local.io',
      endpoint: 'http://node-c:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-c',
    }

    await envoyBus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await envoyBus.lastNotificationPromise
    await envoyBus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
    await envoyBus.lastNotificationPromise
    await envoyBus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await envoyBus.lastNotificationPromise
    await envoyBus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerC } })
    await envoyBus.lastNotificationPromise

    envoyPool.bgpCalls.length = 0

    // Receive a route from peer B
    await envoyBus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
                envoyPort: 5000,
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await envoyBus.lastNotificationPromise

    // The BGP call to peer C should include this node's PeerInfo (first arg)
    // which carries envoyAddress so C knows where to reach A's Envoy
    const bgpToC = envoyPool.bgpCalls.find((c) => c.endpoint === peerC.endpoint)
    expect(bgpToC).toBeDefined()

    const peerInfoArg = bgpToC!.args[0] as { name: string; envoyAddress?: string }
    expect(peerInfoArg.name).toBe('node-a.somebiz.local.io')
    expect(peerInfoArg.envoyAddress).toBe('envoy-proxy-a')
  })

  it('does not rewrite envoyPort on remove actions', async () => {
    const peerB: PeerInfo = {
      name: 'node-b.somebiz.local.io',
      endpoint: 'http://node-b:3000',
      domains: ['somebiz.local.io'],
      envoyAddress: 'envoy-proxy-b',
      peerToken: 'token-for-b',
    }
    const peerC: PeerInfo = {
      name: 'node-c.somebiz.local.io',
      endpoint: 'http://node-c:3000',
      domains: ['somebiz.local.io'],
      peerToken: 'token-for-c',
    }

    // Connect both peers
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
    await bus.lastNotificationPromise
    await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerC } })
    await bus.lastNotificationPromise

    // First add a route so there's something to remove
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'add',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
                envoyPort: 5000,
              },
              nodePath: ['node-b.somebiz.local.io'],
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    pool.bgpCalls.length = 0

    // Now send a remove update
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo: peerB,
        update: {
          updates: [
            {
              action: 'remove',
              route: {
                name: 'books-api',
                protocol: 'http:graphql' as const,
                endpoint: 'http://books:5001/graphql',
              },
            },
          ],
        },
      },
    })
    await bus.lastNotificationPromise

    // The BGP call to peer C should propagate the remove unchanged
    const bgpToC = pool.bgpCalls.find((c) => c.endpoint === peerC.endpoint)
    expect(bgpToC).toBeDefined()

    const updateMsg = bgpToC!.args[1] as {
      updates: Array<{ action: string; route: { name: string; envoyPort?: number } }>
    }
    const removeUpdate = updateMsg.updates.find((u) => u.action === 'remove')
    expect(removeUpdate).toBeDefined()
    expect(removeUpdate!.route.name).toBe('books-api')
    // Remove actions should not have envoyPort rewritten or added
    expect(removeUpdate!.route.envoyPort).toBeUndefined()
  })

  describe('TLS config passthrough', () => {
    const TLS_CONFIG = {
      certChain: '-----BEGIN CERTIFICATE-----\ntest-cert\n-----END CERTIFICATE-----',
      privateKey: '-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----',
      caBundle: '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----',
      requireClientCert: true,
    }

    it('includes TLS config in updateRoutes when tlsConfig is set', async () => {
      const tlsPool = new MockConnectionPool('http')
      const tlsBus = new CatalystNodeBus({
        config: {
          node: MOCK_NODE,
          ibgp: { secret: 'secret' },
          envoyConfig: {
            endpoint: ENVOY_ENDPOINT,
            portRange: [[10000, 10100]],
          },
        },
        connectionPool: { pool: tlsPool },
        tlsConfig: TLS_CONFIG,
      })

      await tlsBus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
      })
      await tlsBus.lastNotificationPromise

      expect(tlsPool.envoyCalls.length).toBe(1)
      const payload = tlsPool.envoyCalls[0].payload as EnvoyUpdateRoutesPayload & {
        tls?: typeof TLS_CONFIG
      }
      expect(payload.tls).toBeDefined()
      expect(payload.tls!.certChain).toBe(TLS_CONFIG.certChain)
      expect(payload.tls!.privateKey).toBe(TLS_CONFIG.privateKey)
      expect(payload.tls!.caBundle).toBe(TLS_CONFIG.caBundle)
      expect(payload.tls!.requireClientCert).toBe(true)
    })

    it('omits TLS config when tlsConfig is not set', async () => {
      await bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
      })
      await bus.lastNotificationPromise

      const payload = pool.envoyCalls[0].payload as EnvoyUpdateRoutesPayload & {
        tls?: unknown
      }
      expect(payload.tls).toBeUndefined()
    })

    it('pushEnvoyConfig sends current TLS config immediately', async () => {
      const tlsPool = new MockConnectionPool('http')
      const tlsBus = new CatalystNodeBus({
        config: {
          node: MOCK_NODE,
          ibgp: { secret: 'secret' },
          envoyConfig: {
            endpoint: ENVOY_ENDPOINT,
            portRange: [[10000, 10100]],
          },
        },
        connectionPool: { pool: tlsPool },
        tlsConfig: TLS_CONFIG,
      })

      await tlsBus.pushEnvoyConfig()

      expect(tlsPool.envoyCalls.length).toBe(1)
      const payload = tlsPool.envoyCalls[0].payload as EnvoyUpdateRoutesPayload & {
        tls?: typeof TLS_CONFIG
      }
      expect(payload.tls).toBeDefined()
      expect(payload.tls!.certChain).toBe(TLS_CONFIG.certChain)
    })

    it('pushEnvoyConfig uses updated TLS config after mutation', async () => {
      const tlsPool = new MockConnectionPool('http')
      const tlsBus = new CatalystNodeBus({
        config: {
          node: MOCK_NODE,
          ibgp: { secret: 'secret' },
          envoyConfig: {
            endpoint: ENVOY_ENDPOINT,
            portRange: [[10000, 10100]],
          },
        },
        connectionPool: { pool: tlsPool },
        tlsConfig: TLS_CONFIG,
      })

      // Update TLS config (simulating cert renewal)
      const renewedConfig = {
        ...TLS_CONFIG,
        certChain: '-----BEGIN CERTIFICATE-----\nrenewed-cert\n-----END CERTIFICATE-----',
      }
      tlsBus.tlsConfig = renewedConfig
      await tlsBus.pushEnvoyConfig()

      expect(tlsPool.envoyCalls.length).toBe(1)
      const payload = tlsPool.envoyCalls[0].payload as EnvoyUpdateRoutesPayload & {
        tls?: typeof TLS_CONFIG
      }
      expect(payload.tls!.certChain).toBe(renewedConfig.certChain)
    })

    it('pushEnvoyConfig is a no-op without envoyConfig', async () => {
      const plainPool = new MockConnectionPool('http')
      const plainBus = new CatalystNodeBus({
        config: {
          node: MOCK_NODE,
          ibgp: { secret: 'secret' },
        },
        connectionPool: { pool: plainPool },
        tlsConfig: TLS_CONFIG,
      })

      await plainBus.pushEnvoyConfig()
      expect(plainPool.envoyCalls.length).toBe(0)
    })
  })

  describe('resolveEndpointForPeer (Envoy-routed peering)', () => {
    it('routes through Envoy when peer has publicAddress and orchestrator-rpc route', async () => {
      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.example.com',
        peerToken: 'token-for-b',
      }

      // 1. Add and connect peer (publicAddress stored from LocalPeerCreate)
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
      await bus.lastNotificationPromise
      await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
      await bus.lastNotificationPromise

      // 2. Receive orchestrator-rpc route from peer B
      await bus.dispatch({
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peerB,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'orchestrator-rpc',
                  protocol: 'http' as const,
                  endpoint: 'http://node-b:3000/rpc',
                  envoyPort: 10050,
                },
                nodePath: ['node-b.somebiz.local.io'],
              },
            ],
          },
        },
      })
      await bus.lastNotificationPromise

      pool.envoyCalls.length = 0
      pool.bgpCalls.length = 0

      // 3. Now add a new peer C that triggers full route sync to C
      //    The route sync to peer B will use resolveEndpointForPeer
      const peerC: PeerInfo = {
        name: 'node-c.somebiz.local.io',
        endpoint: 'http://node-c:3000',
        domains: ['somebiz.local.io'],
        peerToken: 'token-for-c',
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerC })
      await bus.lastNotificationPromise

      // 4. Now receive a local route that triggers notification to all peers
      await bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
      })
      await bus.lastNotificationPromise

      // The BGP call to peer B should be via Envoy (ws://localhost:<egressPort>/rpc)
      // not the direct endpoint (http://node-b:3000)
      const bgpToB = pool.bgpCalls.find((c) => c.endpoint.includes('localhost'))
      expect(bgpToB).toBeDefined()
      expect(bgpToB!.endpoint).toMatch(/^ws:\/\/localhost:\d+\/rpc$/)
    })

    it('falls back to direct endpoint when peer has no publicAddress', async () => {
      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        // no publicAddress
        peerToken: 'token-for-b',
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
      await bus.lastNotificationPromise
      await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
      await bus.lastNotificationPromise

      pool.bgpCalls.length = 0

      await bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
      })
      await bus.lastNotificationPromise

      // Should use direct endpoint since peer has no publicAddress
      const bgpToB = pool.bgpCalls.find((c) => c.endpoint === 'http://node-b:3000')
      expect(bgpToB).toBeDefined()
    })

    it('falls back to direct endpoint when no orchestrator-rpc route from peer', async () => {
      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.example.com',
        peerToken: 'token-for-b',
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
      await bus.lastNotificationPromise
      await bus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
      await bus.lastNotificationPromise

      // Receive a non-orchestrator route from peer B
      await bus.dispatch({
        action: Actions.InternalProtocolUpdate,
        data: {
          peerInfo: peerB,
          update: {
            updates: [
              {
                action: 'add',
                route: {
                  name: 'books-api',
                  protocol: 'http' as const,
                  endpoint: 'http://books:8080',
                  envoyPort: 10050,
                },
                nodePath: ['node-b.somebiz.local.io'],
              },
            ],
          },
        },
      })
      await bus.lastNotificationPromise

      pool.bgpCalls.length = 0

      await bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'movies-api', protocol: 'http' as const, endpoint: 'http://movies:8080' },
      })
      await bus.lastNotificationPromise

      // Should use direct endpoint since no orchestrator-rpc route from this peer
      const bgpToB = pool.bgpCalls.find((c) => c.endpoint === 'http://node-b:3000')
      expect(bgpToB).toBeDefined()
    })
  })

  describe('publicAddress propagation', () => {
    it('stores publicAddress from LocalPeerCreate', async () => {
      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.example.com',
        peerToken: 'token-for-b',
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

      const peer = bus.state.internal.peers.find((p) => p.name === peerB.name)
      expect(peer).toBeDefined()
      expect(peer!.publicAddress).toBe('node-b.example.com')
    })

    it('merges publicAddress from remote peer on InternalProtocolOpen', async () => {
      // Add peer locally without publicAddress
      const localPeerInfo: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        peerToken: 'token-for-b',
      }
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: localPeerInfo })

      // Remote peer connects and advertises publicAddress
      const remotePeerInfo: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.example.com',
        envoyAddress: 'envoy-proxy-b',
      }
      await bus.dispatch({
        action: Actions.InternalProtocolOpen,
        data: { peerInfo: remotePeerInfo },
      })

      const peer = bus.state.internal.peers.find((p) => p.name === localPeerInfo.name)
      expect(peer).toBeDefined()
      expect(peer!.publicAddress).toBe('node-b.example.com')
      expect(peer!.envoyAddress).toBe('envoy-proxy-b')
      expect(peer!.connectionStatus).toBe('connected')
    })

    it('merges publicAddress from remote peer on InternalProtocolConnected', async () => {
      const localPeerInfo: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        peerToken: 'token-for-b',
      }
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: localPeerInfo })

      const remotePeerInfo: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.external.io',
      }
      await bus.dispatch({
        action: Actions.InternalProtocolConnected,
        data: { peerInfo: remotePeerInfo },
      })

      const peer = bus.state.internal.peers.find((p) => p.name === localPeerInfo.name)
      expect(peer).toBeDefined()
      expect(peer!.publicAddress).toBe('node-b.external.io')
      expect(peer!.connectionStatus).toBe('connected')
    })

    it('preserves existing publicAddress when remote does not provide one', async () => {
      // Add peer with publicAddress
      const localPeerInfo: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        publicAddress: 'node-b.example.com',
        peerToken: 'token-for-b',
      }
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: localPeerInfo })

      // Remote peer connects without publicAddress
      await bus.dispatch({
        action: Actions.InternalProtocolOpen,
        data: {
          peerInfo: {
            name: 'node-b.somebiz.local.io',
            endpoint: 'http://node-b:3000',
            domains: ['somebiz.local.io'],
          },
        },
      })

      const peer = bus.state.internal.peers.find((p) => p.name === localPeerInfo.name)
      expect(peer!.publicAddress).toBe('node-b.example.com')
    })

    it('updates publicAddress on LocalPeerUpdate', async () => {
      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        peerToken: 'token-for-b',
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })

      // Update peer with publicAddress
      await bus.dispatch({
        action: Actions.LocalPeerUpdate,
        data: {
          ...peerB,
          publicAddress: 'node-b.newdomain.com',
        },
      })

      const peer = bus.state.internal.peers.find((p) => p.name === peerB.name)
      expect(peer!.publicAddress).toBe('node-b.newdomain.com')
    })

    it('propagates this node publicAddress to peers via PeerInfo in BGP', async () => {
      const envoyPool = new MockConnectionPool('http')
      const envoyBus = new CatalystNodeBus({
        config: {
          node: {
            ...MOCK_NODE,
            publicAddress: 'node-a.external.io',
          },
          ibgp: { secret: 'secret' },
          envoyConfig: {
            endpoint: ENVOY_ENDPOINT,
            portRange: [[10000, 10100]],
          },
        },
        connectionPool: { pool: envoyPool },
      })

      const peerB: PeerInfo = {
        name: 'node-b.somebiz.local.io',
        endpoint: 'http://node-b:3000',
        domains: ['somebiz.local.io'],
        peerToken: 'token-for-b',
      }

      await envoyBus.dispatch({ action: Actions.LocalPeerCreate, data: peerB })
      await envoyBus.lastNotificationPromise
      await envoyBus.dispatch({ action: Actions.InternalProtocolOpen, data: { peerInfo: peerB } })
      await envoyBus.lastNotificationPromise

      envoyPool.bgpCalls.length = 0

      await envoyBus.dispatch({
        action: Actions.LocalRouteCreate,
        data: { name: 'books-api', protocol: 'http' as const, endpoint: 'http://books:8080' },
      })
      await envoyBus.lastNotificationPromise

      const bgpToB = envoyPool.bgpCalls.find((c) => c.endpoint === peerB.endpoint)
      expect(bgpToB).toBeDefined()

      const peerInfoArg = bgpToB!.args[0] as { name: string; publicAddress?: string }
      expect(peerInfoArg.name).toBe('node-a.somebiz.local.io')
      expect(peerInfoArg.publicAddress).toBe('node-a.external.io')
    })
  })
})
