import { describe, it, expect, beforeEach } from 'bun:test'
import { PeerTransport, type Propagation, type UpdateMessage } from '../src/peer-transport.js'
import { ConnectionPool, type PublicApi } from '../src/orchestrator.js'
import type { PeerInfo, PeerRecord } from '@catalyst/routing'
import type { RpcStub } from 'capnweb'

class StubConnectionPool extends ConnectionPool {
  public openCalls: Array<{ token: string; peer: PeerInfo }> = []
  public closeCalls: Array<{ token: string; peer: PeerInfo; code: number; reason?: string }> = []
  public updateCalls: Array<{ token: string; peer: PeerInfo; update: UpdateMessage }> = []

  constructor() {
    super('ws')
  }

  override get(_endpoint: string) {
    return {
      getIBGPClient: async (token: string) => {
        return {
          success: true as const,
          client: {
            open: async (peer: PeerInfo) => {
              this.openCalls.push({ token, peer })
              return { success: true as const }
            },
            close: async (peer: PeerInfo, code: number, reason?: string) => {
              this.closeCalls.push({ token, peer, code, reason })
              return { success: true as const }
            },
            update: async (peer: PeerInfo, update: UpdateMessage) => {
              this.updateCalls.push({ token, peer, update })
              return { success: true as const }
            },
          },
        }
      },
    } as unknown as RpcStub<PublicApi>
  }
}

describe('PeerTransport', () => {
  let pool: StubConnectionPool
  let transport: PeerTransport

  const localNode: PeerInfo = {
    name: 'local.somebiz.local.io',
    endpoint: 'ws://local',
    domains: ['somebiz.local.io'],
  }

  const peerA: PeerRecord = {
    name: 'peer-a.somebiz.local.io',
    endpoint: 'ws://peer-a',
    domains: ['somebiz.local.io'],
    peerToken: 'token-a',
    connectionStatus: 'connected',
  }

  const peerB: PeerRecord = {
    name: 'peer-b.somebiz.local.io',
    endpoint: 'ws://peer-b',
    domains: ['somebiz.local.io'],
    peerToken: 'token-b',
    connectionStatus: 'connected',
  }

  beforeEach(() => {
    pool = new StubConnectionPool()
    transport = new PeerTransport(pool)
  })

  describe('sendUpdate', () => {
    it('calls getIBGPClient with peer token then client.update', async () => {
      const update: UpdateMessage = {
        updates: [
          {
            action: 'add',
            route: { name: 'svc', protocol: 'http', endpoint: 'http://svc' },
            nodePath: ['local'],
          },
        ],
      }

      await transport.sendUpdate(peerA, localNode, update)

      expect(pool.updateCalls).toHaveLength(1)
      expect(pool.updateCalls[0].token).toBe('token-a')
      expect(pool.updateCalls[0].peer).toEqual(localNode)
      expect(pool.updateCalls[0].update).toEqual(update)
    })
  })

  describe('sendOpen', () => {
    it('calls getIBGPClient with peer token then client.open', async () => {
      await transport.sendOpen(peerA, localNode)

      expect(pool.openCalls).toHaveLength(1)
      expect(pool.openCalls[0].token).toBe('token-a')
      expect(pool.openCalls[0].peer).toEqual(localNode)
    })
  })

  describe('sendClose', () => {
    it('calls getIBGPClient with peer token then client.close', async () => {
      await transport.sendClose(peerA, localNode, 1000, 'Peer removed')

      expect(pool.closeCalls).toHaveLength(1)
      expect(pool.closeCalls[0].token).toBe('token-a')
      expect(pool.closeCalls[0].peer).toEqual(localNode)
      expect(pool.closeCalls[0].code).toBe(1000)
      expect(pool.closeCalls[0].reason).toBe('Peer removed')
    })
  })

  describe('fanOut', () => {
    it('runs propagations concurrently and returns settled results', async () => {
      const update: UpdateMessage = {
        updates: [
          {
            action: 'add',
            route: { name: 'svc', protocol: 'http', endpoint: 'http://svc' },
            nodePath: ['local'],
          },
        ],
      }

      const propagations: Propagation[] = [
        { type: 'update', peer: peerA, localNode, update },
        { type: 'update', peer: peerB, localNode, update },
      ]

      const results = await transport.fanOut(propagations)

      expect(results).toHaveLength(2)
      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('fulfilled')
      expect(pool.updateCalls).toHaveLength(2)
      expect(pool.updateCalls[0].token).toBe('token-a')
      expect(pool.updateCalls[1].token).toBe('token-b')
    })

    it('handles mixed propagation types', async () => {
      const update: UpdateMessage = {
        updates: [
          { action: 'remove', route: { name: 'svc', protocol: 'http', endpoint: 'http://svc' } },
        ],
      }

      const propagations: Propagation[] = [
        { type: 'open', peer: peerA, localNode },
        { type: 'update', peer: peerB, localNode, update },
        { type: 'close', peer: peerA, localNode, code: 1000, reason: 'done' },
      ]

      const results = await transport.fanOut(propagations)

      expect(results).toHaveLength(3)
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      expect(pool.openCalls).toHaveLength(1)
      expect(pool.updateCalls).toHaveLength(1)
      expect(pool.closeCalls).toHaveLength(1)
    })

    it('settles with rejected for failures without breaking other calls', async () => {
      const failingPool = new StubConnectionPool()
      let callCount = 0
      failingPool.get = (_endpoint: string) => {
        return {
          getIBGPClient: async (_token: string) => {
            callCount++
            if (callCount === 1) throw new Error('connection refused')
            return {
              success: true as const,
              client: {
                update: async () => ({ success: true as const }),
                open: async () => ({ success: true as const }),
                close: async () => ({ success: true as const }),
              },
            }
          },
        } as unknown as RpcStub<PublicApi>
      }

      const failTransport = new PeerTransport(failingPool)
      const update: UpdateMessage = { updates: [] }

      const results = await failTransport.fanOut([
        { type: 'update', peer: peerA, localNode, update },
        { type: 'update', peer: peerB, localNode, update },
      ])

      expect(results).toHaveLength(2)
      expect(results[0].status).toBe('rejected')
      expect(results[1].status).toBe('fulfilled')
    })
  })

  describe('token handling', () => {
    it('throws when peer has no peerToken and no nodeToken', async () => {
      const peerNoToken: PeerRecord = {
        name: 'no-token.somebiz.local.io',
        endpoint: 'ws://no-token',
        domains: ['somebiz.local.io'],
        connectionStatus: 'connected',
      }

      expect(transport.sendUpdate(peerNoToken, localNode, { updates: [] })).rejects.toThrow(
        'No peerToken for no-token.somebiz.local.io and no nodeToken configured'
      )
    })

    it('falls back to nodeToken when peer has no peerToken', async () => {
      const transportWithNodeToken = new PeerTransport(pool, 'node-fallback-token')
      const peerNoToken: PeerRecord = {
        name: 'no-token.somebiz.local.io',
        endpoint: 'ws://no-token',
        domains: ['somebiz.local.io'],
        connectionStatus: 'connected',
      }

      await transportWithNodeToken.sendUpdate(peerNoToken, localNode, { updates: [] })

      expect(pool.updateCalls).toHaveLength(1)
      expect(pool.updateCalls[0].token).toBe('node-fallback-token')
    })
  })
})
