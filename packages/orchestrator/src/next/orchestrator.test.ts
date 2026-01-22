import { describe, it, expect, beforeEach } from 'bun:test'
import type { PeerManager } from './orchestrator'
import { CatalystNodeBus } from './orchestrator'
import type { PeerInfo, RouteTable } from './routing/state'
import { newRouteTable } from './routing/state'

// Helper to access private state for testing
interface TestBus {
  state: RouteTable
}

describe('CatalystNodeBus', () => {
  let bus: CatalystNodeBus

  beforeEach(() => {
    bus = new CatalystNodeBus({ state: newRouteTable() })
  })

  it('should initialize with empty state', () => {
    const state = (bus as unknown as TestBus).state
    expect(state.internal.peers).toEqual([])
    expect(state.internal.routes).toEqual([])
  })

  describe('local:peer:create', () => {
    it('should create a new peer', async () => {
      const peer: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
      }

      const result = await bus.dispatch({
        action: 'local:peer:create',
        data: { peerInfo: peer },
      })

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0]).toMatchObject({
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
        connectionStatus: 'initializing',
      })
    })

    it('should return error if peer already exists', async () => {
      const peer: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
      }

      await bus.dispatch({
        action: 'local:peer:create',
        data: { peerInfo: peer },
      })

      const result = await bus.dispatch({
        action: 'local:peer:create',
        data: { peerInfo: peer },
      })

      expect(result).toEqual({ success: false, error: 'Peer already exists' })
    })
  })

  describe('local:peer:update', () => {
    beforeEach(async () => {
      await bus.dispatch({
        action: 'local:peer:create',
        data: {
          peerInfo: {
            name: 'peer1',
            endpoint: 'http://localhost:8080',
            domains: ['example.com'],
          },
        },
      })
    })

    it('should update an existing peer', async () => {
      const updateData: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:9090',
        domains: ['updated.com'],
      }

      const result = await bus.dispatch({
        action: 'local:peer:update',
        data: { peerInfo: updateData },
      })

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0]).toMatchObject({
        name: 'peer1',
        endpoint: 'http://localhost:9090',
        domains: ['updated.com'],
        connectionStatus: 'initializing',
      })
    })

    it('should return error if peer does not exist', async () => {
      const result = await bus.dispatch({
        action: 'local:peer:update',
        data: {
          peerInfo: {
            name: 'non-existent',
            endpoint: '...',
            domains: [],
          },
        },
      })

      expect(result).toEqual({ success: false, error: 'Peer not found' })
    })
  })

  describe('local:peer:delete', () => {
    beforeEach(async () => {
      await bus.dispatch({
        action: 'local:peer:create',
        data: {
          peerInfo: {
            name: 'peer1',
            endpoint: 'http://localhost:8080',
            domains: ['example.com'],
          },
        },
      })
    })

    it('should remove an existing peer', async () => {
      const result = await bus.dispatch({
        action: 'local:peer:delete',
        data: {
          peerInfo: {
            name: 'peer1',
            endpoint: '',
            domains: [],
          },
        },
      })

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(0)
    })

    it('should return error if peer does not exist', async () => {
      const result = await bus.dispatch({
        action: 'local:peer:delete',
        data: {
          peerInfo: {
            name: 'non-existent',
            endpoint: '',
            domains: [],
          },
        },
      })

      expect(result).toEqual({ success: false, error: 'Peer not found' })
    })
  })

  describe('Public API', () => {
    let api: PeerManager

    beforeEach(() => {
      api = bus.publicApi().getManagerConnection()
    })

    it('should add peer via public API', async () => {
      const peer = {
        name: 'api-peer',
        endpoint: 'http://api.com',
        domains: ['api.com'],
      }

      const result = await api.addPeer(peer)
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0].name).toBe('api-peer')
    })

    it('should update peer via public API', async () => {
      await api.addPeer({
        name: 'api-peer',
        endpoint: 'http://api.com',
        domains: ['api.com'],
      })

      const result = await api.updatePeer({
        name: 'api-peer',
        endpoint: 'http://api-updated.com',
        domains: ['api-updated.com'],
      })
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers[0].endpoint).toBe('http://api-updated.com')
    })

    it('should remove peer via public API', async () => {
      await api.addPeer({
        name: 'api-peer',
        endpoint: 'http://api.com',
        domains: ['api.com'],
      })

      const result = await api.removePeer({ name: 'api-peer' })
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(0)
    })
  })
})
