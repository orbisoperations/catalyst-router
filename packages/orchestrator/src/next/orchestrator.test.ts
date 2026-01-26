import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { PublicApi } from './orchestrator'
import { CatalystNodeBus, ConnectionPool } from './orchestrator'
import type { PeerInfo, RouteTable } from './routing/state'
import { newRouteTable } from './routing/state'
import type { RpcStub } from 'capnweb'
import type { AuthContext } from './types'
import { Actions } from './action-types'

const ADMIN_AUTH: AuthContext = { userId: 'test-admin', roles: ['admin'] }

interface TestBus {
  state: RouteTable
  config: { node: PeerInfo; ibgp?: { secret?: string } }
}

class MockConnectionPool extends ConnectionPool {
  public updateMock = mock(async () => ({ success: true }))

  get(_endpoint: string) {
    return {
      getPeerConnection: async (_secret: string) => {
        return {
          success: true,
          connection: {
            open: async (_peer: PeerInfo) => {
              return { success: true }
            },
            close: async (_peer: PeerInfo, _code: number, _reason?: string) => {
              return { success: true }
            },
            update: this.updateMock,
          },
        }
      },
    } as unknown as RpcStub<PublicApi>
  }
}

describe('CatalystNodeBus', () => {
  let bus: CatalystNodeBus
  const MOCK_NODE: PeerInfo = {
    name: 'node-a.somebiz.local.io',
    endpoint: 'http://localhost:3000',
    domains: ['somebiz.local.io'],
  }

  beforeEach(() => {
    bus = new CatalystNodeBus({
      state: newRouteTable(),
      connectionPool: { pool: new MockConnectionPool() },
      config: { node: MOCK_NODE },
    })
  })

  it('should initialize with empty state', () => {
    const state = (bus as unknown as TestBus).state
    expect(state.internal.peers).toEqual([])
    expect(state.internal.routes).toEqual([])
  })

  describe('Validation', () => {
    it('should throw if name does not end with .somebiz.local.io', () => {
      expect(() => {
        new CatalystNodeBus({
          config: { node: { name: 'invalid', endpoint: '...', domains: [] } },
        })
      }).toThrow('Must end with .somebiz.local.io')
    })

    it('should throw if name suffix does not match configured domains', () => {
      expect(() => {
        new CatalystNodeBus({
          config: {
            node: {
              name: 'node.somebiz.local.io',
              endpoint: '...',
              domains: ['other.com'],
            },
          },
        })
      }).toThrow('does not match any configured domains')
    })
  })

  describe('local:peer:create', () => {
    it('should create a new peer', async () => {
      const peer: PeerInfo = {
        name: 'peer1.somebiz.local.io',
        endpoint: 'http://localhost:8080',
        domains: ['somebiz.local.io'],
      }

      const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer }, ADMIN_AUTH)

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0]).toMatchObject({
        name: 'peer1.somebiz.local.io',
        endpoint: 'http://localhost:8080',
        domains: ['somebiz.local.io'],
        connectionStatus: 'connected',
      })
    })
  })

  describe('Route Updates and BGP Path Logic', () => {
    it('should process internal:protocol:update adds and include nodePath', async () => {
      const peerInfo = {
        name: 'remote-peer.somebiz.local.io',
        endpoint: 'http://remote.com',
        domains: ['somebiz.local.io'],
      }
      const route = {
        name: 'remote-service',
        protocol: 'http' as const,
        endpoint: 'http://remote-service',
      }

      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: peerInfo,
            update: {
              updates: [{ action: 'add', route: route, nodePath: ['hop1.somebiz.local.io'] }],
            },
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(1)
      expect(state.internal.routes[0]).toMatchObject({
        ...route,
        peerName: 'remote-peer.somebiz.local.io',
        nodePath: ['hop1.somebiz.local.io'],
      })
    })

    it('should drop updates if loop detected in nodePath', async () => {
      const peerInfo = {
        name: 'remote-peer.somebiz.local.io',
        endpoint: 'http://remote.com',
        domains: ['somebiz.local.io'],
      }
      const route = {
        name: 'loop-service',
        protocol: 'http' as const,
        endpoint: 'http://loop',
      }

      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo,
            update: {
              updates: [
                {
                  action: 'add',
                  route,
                  nodePath: ['hop1.somebiz.local.io', MOCK_NODE.name],
                },
              ],
            },
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(0)
    })

    it('should prepend local FQDN when propagating updates', async () => {
      const peerInfo = {
        name: 'remote-peer.somebiz.local.io',
        endpoint: 'http://remote.com',
        domains: ['somebiz.local.io'],
      }

      // 1. Configure another peer and connect it
      const peer2: PeerInfo = {
        name: 'peer2.somebiz.local.io',
        endpoint: 'http://peer2.com',
        domains: ['somebiz.local.io'],
      }
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer2 }, ADMIN_AUTH)

      // 2. Receive update from remote-peer
      const update = {
        updates: [
          {
            action: 'add',
            route: { name: 'service1', protocol: 'http' as const, endpoint: 'http://s1' },
            nodePath: ['remote-peer.somebiz.local.io'],
          },
        ],
      }

      await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: { peerInfo, update },
        },
        ADMIN_AUTH
      )

      // 3. Verify update sent to peer2 has prepended nodePath
      const pool = (bus as unknown as { connectionPool: MockConnectionPool }).connectionPool
      const calls = pool.updateMock.mock.calls
      const lastCall = calls[calls.length - 1] as unknown[]
      const updateMsg = lastCall[1] as { updates: { nodePath: string[] }[] }

      expect(updateMsg.updates[0].nodePath).toEqual([
        MOCK_NODE.name,
        'remote-peer.somebiz.local.io',
      ])
    })
  })

  describe('getPeerConnection', () => {
    it('should allow BGP handshake if PSK matches', () => {
      const busWithSecret = new CatalystNodeBus({
        config: { node: MOCK_NODE, ibgp: { secret: 'secret123' } },
      })
      const api = busWithSecret.publicApi()
      const result = api.getPeerConnection('secret123')
      expect(result.success).toBe(true)
    })
  })
})
