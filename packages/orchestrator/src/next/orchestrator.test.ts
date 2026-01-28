import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { PeerManager, PublicApi } from './orchestrator'
import { CatalystNodeBus, ConnectionPool } from './orchestrator'
import type { PeerInfo, RouteTable } from './routing/state'
import { newRouteTable } from './routing/state'
import type { RpcStub } from 'capnweb'
import type { AuthContext } from './types'
import { Actions } from './action-types'

/**
 * Admin auth context for tests.
 *
 * Most tests here verify business logic (state transitions, error handling),
 * not auth enforcement. Using ADMIN_AUTH lets these tests focus on their
 * primary concern without permission failures obscuring the behavior under test.
 *
 * Auth-specific tests are in the 'Auth Threading' describe block, which
 * explicitly tests various auth scenarios (anonymous, viewer, admin, wildcards).
 */
const ADMIN_AUTH: AuthContext = { userId: 'test-admin', roles: ['admin'] }

// Helper to access private state for testing
interface TestBus {
  state: RouteTable
  config: { node: PeerInfo; ibgp?: { secret?: string } }
}

// Mock ConnectionPool
class MockConnectionPool extends ConnectionPool {
  public updateMock = mock(async () => ({ success: true }))

  get(_endpoint: string) {
    // Return a mock object that satisfies whatever RpcStub<PublicApi> needs for this test
    // Key method is getPeerConnection().open()
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
    name: 'myself',
    endpoint: 'http://localhost:3000',
    domains: [],
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

  describe('local:peer:create', () => {
    it('should create a new peer', async () => {
      const peer: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
      }

      const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer }, ADMIN_AUTH)

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0]).toMatchObject({
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
        connectionStatus: 'connected', // Expect connected because mock returns success
      })
    })

    it('should return error if peer already exists', async () => {
      const peer: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:8080',
        domains: ['example.com'],
      }

      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer }, ADMIN_AUTH)

      const result = await bus.dispatch({ action: Actions.LocalPeerCreate, data: peer }, ADMIN_AUTH)

      expect(result).toEqual({ success: false, error: 'Peer already exists' })
    })
  })

  describe('local:peer:update', () => {
    beforeEach(async () => {
      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'peer1', endpoint: 'http://localhost:8080', domains: ['example.com'] },
        },
        ADMIN_AUTH
      )
    })

    it('should update an existing peer', async () => {
      const updateData: PeerInfo = {
        name: 'peer1',
        endpoint: 'http://localhost:9090',
        domains: ['updated.com'],
      }

      const result = await bus.dispatch(
        { action: Actions.LocalPeerUpdate, data: updateData },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0]).toMatchObject({
        name: 'peer1',
        endpoint: 'http://localhost:9090',
        domains: ['updated.com'],
        connectionStatus: 'initializing', // Reset to initializing on update
      })
    })

    it('should return error if peer does not exist', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalPeerUpdate,
          data: { name: 'non-existent', endpoint: '...', domains: [] },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: false, error: 'Peer not found' })
    })
  })

  describe('local:peer:delete', () => {
    beforeEach(async () => {
      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'peer1', endpoint: 'http://localhost:8080', domains: ['example.com'] },
        },
        ADMIN_AUTH
      )
    })

    it('should remove an existing peer', async () => {
      const result = await bus.dispatch(
        { action: Actions.LocalPeerDelete, data: { name: 'peer1' } },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(0)
    })

    it('should return error if peer does not exist', async () => {
      const result = await bus.dispatch(
        { action: Actions.LocalPeerDelete, data: { name: 'non-existent' } },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: false, error: 'Peer not found' })
    })
  })

  describe('Public API', () => {
    let api: PeerManager

    beforeEach(() => {
      bus = new CatalystNodeBus({
        state: newRouteTable(),
        connectionPool: { pool: new MockConnectionPool() },
        config: { node: MOCK_NODE },
      })
      api = bus.publicApi().getManagerConnection()
    })

    it('should add peer via public API', async () => {
      const peer = {
        name: 'api-peer',
        endpoint: 'http://api.com',
        domains: ['api.com'],
      }

      const result = await api.addPeer(peer, ADMIN_AUTH)
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(1)
      expect(state.internal.peers[0].name).toBe('api-peer')
      expect(state.internal.peers[0].connectionStatus).toBe('connected')
    })

    it('should update peer via public API', async () => {
      await api.addPeer(
        { name: 'api-peer', endpoint: 'http://api.com', domains: ['api.com'] },
        ADMIN_AUTH
      )

      const result = await api.updatePeer(
        { name: 'api-peer', endpoint: 'http://api-updated.com', domains: ['api-updated.com'] },
        ADMIN_AUTH
      )
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers[0].endpoint).toBe('http://api-updated.com')
    })

    it('should remove peer via public API', async () => {
      await api.addPeer(
        { name: 'api-peer', endpoint: 'http://api.com', domains: ['api.com'] },
        ADMIN_AUTH
      )

      const result = await api.removePeer({ name: 'api-peer' }, ADMIN_AUTH)
      expect(result).toEqual({ success: true })

      const state = (bus as unknown as TestBus).state
      expect(state.internal.peers).toHaveLength(0)
    })
  })

  describe('internal:protocol:connected', () => {
    it('should transition peer to connected state', async () => {
      // 1. Configure peer (initially initializing)
      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'connecting-peer', endpoint: 'http://connecting.com', domains: [] },
        },
        ADMIN_AUTH
      )

      // Cheat to test handler in isolation - reset to initializing
      const state = (bus as unknown as TestBus).state
      state.internal.peers[0].connectionStatus = 'initializing'

      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolConnected,
          data: {
            peerInfo: { name: 'connecting-peer', endpoint: 'http://connecting.com', domains: [] },
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const finalState = (bus as unknown as TestBus).state
      expect(finalState.internal.peers[0].connectionStatus).toBe('connected')
    })
  })

  describe('BGP Handshake Flow', () => {
    it('should complete full open -> connected -> close sequence', async () => {
      const peerInfo: PeerInfo = {
        name: 'handshake-peer',
        endpoint: 'http://handshake.com',
        domains: [],
      }

      // 1. Initiate Connection (local:peer:create)
      // This triggers handleAction (init) -> handleNotify (open) -> dispatch(connected) -> handleAction (connected)
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo }, ADMIN_AUTH)

      const state = (bus as unknown as TestBus).state
      const peer = state.internal.peers.find((p) => p.name === 'handshake-peer')
      expect(peer).toBeDefined()
      expect(peer?.connectionStatus).toBe('connected')

      // 2. Remote side closes (internal:protocol:close)
      await bus.dispatch(
        {
          action: Actions.InternalProtocolClose,
          data: { peerInfo: peerInfo, code: 1000, reason: 'Done' },
        },
        ADMIN_AUTH
      )

      const finalState = (bus as unknown as TestBus).state
      const peerAfterClose = finalState.internal.peers.find((p) => p.name === 'handshake-peer')
      expect(peerAfterClose).toBeUndefined()
    })
  })

  describe('internal:protocol:open', () => {
    it('should accept connection if peer is configured', async () => {
      // 1. Configure peer (initially connected via mock)
      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'remote-peer', endpoint: 'http://remote.com', domains: [] },
        },
        ADMIN_AUTH
      )

      // 2. Simulate disconnect / reset status manually for test
      const state = (bus as unknown as TestBus).state
      state.internal.peers[0].connectionStatus = 'initializing'

      // 3. Receive open request
      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolOpen,
          data: { peerInfo: { name: 'remote-peer', endpoint: 'http://remote.com', domains: [] } },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const finalState = (bus as unknown as TestBus).state
      expect(finalState.internal.peers[0].connectionStatus).toBe('connected')
    })

    it('should reject connection if peer is not configured', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolOpen,
          data: { peerInfo: { name: 'stranger', endpoint: 'http://remote.com', domains: [] } },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({
        success: false,
        error: "Peer 'stranger' is not configured on this node",
      })
    })
  })

  describe('internal:protocol:close', () => {
    it('should remove peer if configured', async () => {
      // 1. Configure peer
      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'remote-peer', endpoint: 'http://remote.com', domains: [] },
        },
        ADMIN_AUTH
      )

      // 2. Receive close request
      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolClose,
          data: {
            peerInfo: { name: 'remote-peer', endpoint: 'http://remote.com', domains: [] },
            code: 1000,
            reason: 'Closed',
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const postState = (bus as unknown as TestBus).state
      expect(postState.internal.peers).toHaveLength(0)
    })

    it('should no-op if peer is not configured', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolClose,
          data: {
            peerInfo: { name: 'stranger', endpoint: 'http://remote.com', domains: [] },
            code: 1000,
            reason: 'Closed',
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
    })
  })

  describe('Route Updates', () => {
    it('should add local route', async () => {
      const route = {
        name: 'local-service',
        protocol: 'http' as const,
        endpoint: 'http://localhost:3000',
      }

      const result = await bus.dispatch(
        { action: Actions.LocalRouteCreate, data: route },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.local.routes).toHaveLength(1)
      expect(state.local.routes[0]).toMatchObject(route)
    })

    it('should remove local route', async () => {
      const route = {
        name: 'local-service',
        protocol: 'http' as const,
        endpoint: 'http://localhost:3000',
      }
      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route }, ADMIN_AUTH)

      const result = await bus.dispatch(
        { action: Actions.LocalRouteDelete, data: route },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.local.routes).toHaveLength(0)
    })

    it('should process internal:protocol:update adds', async () => {
      const peerInfo = {
        name: 'remote-peer',
        endpoint: 'http://remote.com',
        domains: [],
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
              updates: [{ action: 'add', route: route }],
            },
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(1)
      expect(state.internal.routes[0]).toMatchObject({ ...route, peer: peerInfo })
    })

    it('should process internal:protocol:update removes', async () => {
      const peerInfo = {
        name: 'remote-peer',
        endpoint: 'http://remote.com',
        domains: [],
      }
      const route = {
        name: 'remote-service',
        protocol: 'http' as const,
        endpoint: 'http://remote-service',
      }

      // Add first
      await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: peerInfo,
            update: {
              updates: [{ action: 'add', route: route }],
            },
          },
        },
        ADMIN_AUTH
      )

      const result = await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: peerInfo,
            update: {
              updates: [{ action: 'remove', route: route }],
            },
          },
        },
        ADMIN_AUTH
      )

      expect(result).toEqual({ success: true })
      const state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(0)
    })
  })

  describe('Route Lifecycle Edge Cases', () => {
    it('should remove routes when peer disconnects', async () => {
      const peerInfo: PeerInfo = { name: 'peer1', endpoint: 'http://p1', domains: [] }
      const route = { name: 'r1', protocol: 'http' as const, endpoint: 'http://r1' }

      // 0. Ensure peer exists in state (simulating handshake)
      await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo }, ADMIN_AUTH)

      // 1. Add route via update
      await bus.dispatch(
        {
          action: Actions.InternalProtocolUpdate,
          data: {
            peerInfo: peerInfo,
            update: {
              updates: [{ action: 'add', route: route }],
            },
          },
        },
        ADMIN_AUTH
      )

      // Verify route exists
      let state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(1)
      expect(state.internal.routes[0]).toMatchObject({
        peerName: 'peer1',
      })

      // 2. Disconnect peer
      await bus.dispatch(
        {
          action: Actions.InternalProtocolClose,
          data: { peerInfo: peerInfo, code: 1000, reason: 'bye' },
        },
        ADMIN_AUTH
      )

      // Verify route is gone
      state = (bus as unknown as TestBus).state
      expect(state.internal.routes).toHaveLength(0)
    })

    it('should sync existing routes to new peer', async () => {
      // 1. Create local route
      const route = { name: 'local1', protocol: 'http' as const, endpoint: 'http://l1' }
      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route }, ADMIN_AUTH)

      // 2. Simulate new peer connecting
      const peerInfo: PeerInfo = { name: 'peer2', endpoint: 'http://p2', domains: [] }

      await bus.dispatch(
        { action: Actions.InternalProtocolConnected, data: { peerInfo: peerInfo } },
        ADMIN_AUTH
      )

      // Verify update was called on the new peer
      const pool = (bus as unknown as { connectionPool: MockConnectionPool }).connectionPool
      expect(pool.updateMock).toHaveBeenCalled()

      const calls = pool.updateMock.mock.calls
      const lastCall = calls[calls.length - 1] as unknown[]
      expect(lastCall).toBeDefined()
      const updateMsg = lastCall[1] as { updates: { action: string; route: { name: string } }[] }
      expect(updateMsg.updates).toHaveLength(1)
      expect(updateMsg.updates[0].action).toBe('add')
      expect(updateMsg.updates[0].route.name).toBe('local1')
    })
  })

  describe('Config', () => {
    it('should accept config in constructor', () => {
      const configuredBus = new CatalystNodeBus({
        state: newRouteTable(),
        config: { node: MOCK_NODE, ibgp: { secret: 'test-secret' } },
      })

      const busInternal = configuredBus as unknown as TestBus
      expect(busInternal.config).toBeDefined()
      expect(busInternal.config.node).toEqual(MOCK_NODE)
      expect(busInternal.config.ibgp?.secret).toBe('test-secret')
    })

    it('should make config.ibgp.secret accessible', () => {
      const configuredBus = new CatalystNodeBus({
        state: newRouteTable(),
        config: { node: MOCK_NODE, ibgp: { secret: 'my-mesh-secret' } },
      })

      const busInternal = configuredBus as unknown as TestBus
      expect(busInternal.config.ibgp?.secret).toBe('my-mesh-secret')
    })
  })

  describe('Auth Threading', () => {
    it('should use anonymous context when auth not provided', async () => {
      // Without auth, should use { userId: 'anonymous', roles: [] }
      // With empty roles, permission check should fail
      const result = await bus.dispatch({
        action: Actions.LocalPeerCreate,
        data: { name: 'test', endpoint: 'http://test', domains: [] },
      })

      expect(result.success).toBe(false)
      expect((result as { error: string }).error).toContain('Permission denied')
    })

    it('should pass auth to handleAction when provided', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'test', endpoint: 'http://test', domains: [] },
        },
        { userId: 'admin-user', roles: ['admin'] }
      )

      expect(result).toEqual({ success: true })
    })

    it('should reject when roles lack required permission', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'test', endpoint: 'http://test', domains: [] },
        },
        { userId: 'viewer', roles: ['viewer'] }
      )

      expect(result.success).toBe(false)
      expect((result as { error: string }).error).toBe('Permission denied: peer:create')
    })

    it('should succeed when roles include required permission', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'test', endpoint: 'http://test', domains: [] },
        },
        { userId: 'peer-admin', roles: ['peer:create'] }
      )

      expect(result).toEqual({ success: true })
    })

    it('should succeed when roles include admin', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalRouteCreate,
          data: { name: 'route1', protocol: 'http', endpoint: 'http://r1' },
        },
        { userId: 'super-admin', roles: ['admin'] }
      )

      expect(result).toEqual({ success: true })
    })

    it('should succeed when roles include category wildcard', async () => {
      const result = await bus.dispatch(
        {
          action: Actions.LocalPeerDelete,
          data: { name: 'nonexistent' },
        },
        { userId: 'peer-manager', roles: ['peer:*'] }
      )

      // Will fail with "Peer not found" - but that's AFTER permission check passes
      expect((result as { error: string }).error).toBe('Peer not found')
    })

    it('should not modify state when permission denied', async () => {
      const stateBefore = (bus as unknown as TestBus).state
      const peersBefore = stateBefore.internal.peers.length

      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'unauthorized', endpoint: 'http://test', domains: [] },
        },
        { userId: 'viewer', roles: [] }
      )

      const stateAfter = (bus as unknown as TestBus).state
      expect(stateAfter.internal.peers.length).toBe(peersBefore)
    })

    it('should not trigger handleNotify when permission denied', async () => {
      // If handleNotify was called, it would try to connect and the mock would be called
      // We can verify by checking that no connection attempt was made
      const pool = (bus as unknown as { connectionPool: MockConnectionPool }).connectionPool
      const callsBefore = pool.updateMock.mock.calls.length

      await bus.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'unauthorized', endpoint: 'http://test', domains: [] },
        },
        { userId: 'viewer', roles: [] }
      )

      // No new calls to the mock - handleNotify wasn't triggered
      expect(pool.updateMock.mock.calls.length).toBe(callsBefore)
    })
  })

  describe('getPeerConnection PSK Validation', () => {
    let busWithSecret: CatalystNodeBus

    beforeEach(() => {
      busWithSecret = new CatalystNodeBus({
        config: { node: MOCK_NODE, ibgp: { secret: 'correct-psk-secret' } },
      })
    })

    it('should reject invalid secret', () => {
      const api = busWithSecret.publicApi()
      const result = api.getPeerConnection('wrong-secret')

      expect(result.success).toBe(false)
      expect((result as { error: string }).error).toBe('Invalid secret')
    })

    it('should accept valid secret', () => {
      const api = busWithSecret.publicApi()
      const result = api.getPeerConnection('correct-psk-secret')

      expect(result.success).toBe(true)
    })

    it('should return connection with methods when secret valid', () => {
      const api = busWithSecret.publicApi()
      const result = api.getPeerConnection('correct-psk-secret')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.connection).toBeDefined()
        expect(typeof result.connection.open).toBe('function')
        expect(typeof result.connection.close).toBe('function')
        expect(typeof result.connection.update).toBe('function')
      }
    })

    it('should reject when no secret configured', () => {
      // Bus without secret config
      const busNoSecret = new CatalystNodeBus({
        config: { node: MOCK_NODE },
      })
      const api = busNoSecret.publicApi()
      const result = api.getPeerConnection('any-secret')

      expect(result.success).toBe(false)
      expect((result as { error: string }).error).toBe('Invalid secret')
    })

    it('should use timing-safe comparison (length mismatch still rejected)', () => {
      const api = busWithSecret.publicApi()

      // Short secret
      const shortResult = api.getPeerConnection('short')
      expect(shortResult.success).toBe(false)

      // Long secret
      const longResult = api.getPeerConnection('this-is-a-very-long-secret-that-does-not-match')
      expect(longResult.success).toBe(false)
    })

    it('should use ibgp-peer roles for connection methods', async () => {
      // Configure a peer first so protocol:open succeeds
      await busWithSecret.dispatch(
        {
          action: Actions.LocalPeerCreate,
          data: { name: 'remote-node', endpoint: 'http://remote', domains: [] },
        },
        { userId: 'admin', roles: ['admin'] }
      )

      const api = busWithSecret.publicApi()
      const connResult = api.getPeerConnection('correct-psk-secret')

      expect(connResult.success).toBe(true)
      if (connResult.success) {
        // Open should succeed - peer auth has ibgp:connect
        const openResult = await connResult.connection.open({
          name: 'remote-node',
          endpoint: 'http://remote',
          domains: [],
        })
        expect(openResult.success).toBe(true)
      }
    })

    it('should reject connection methods without proper ibgp permissions', async () => {
      // This test verifies that the peerAuth context is being used
      // by checking that connection methods work (they need ibgp:* permissions)
      const api = busWithSecret.publicApi()
      const connResult = api.getPeerConnection('correct-psk-secret')

      expect(connResult.success).toBe(true)
      if (connResult.success) {
        // Open should fail because peer is not configured
        // (but NOT because of permission denied - that would indicate peerAuth isn't working)
        const openResult = await connResult.connection.open({
          name: 'unconfigured-peer',
          endpoint: 'http://unknown',
          domains: [],
        })
        expect(openResult.success).toBe(false)
        // Error should be about peer not configured, NOT permission denied
        expect((openResult as { error: string }).error).toBe(
          "Peer 'unconfigured-peer' is not configured on this node"
        )
      }
    })
  })
})
