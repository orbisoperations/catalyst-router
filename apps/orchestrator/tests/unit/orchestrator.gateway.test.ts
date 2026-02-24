import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Actions, type PeerInfo } from '@catalyst/routing'
import { CatalystNodeBus, ConnectionPool, type PublicApi } from '../../src/orchestrator.js'
import type { RpcStub } from 'capnweb'

const MOCK_NODE = {
  name: 'node-a.somebiz.local.io',
  endpoint: 'http://node-a:3000',
  domains: ['somebiz.local.io'],
} satisfies PeerInfo

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
