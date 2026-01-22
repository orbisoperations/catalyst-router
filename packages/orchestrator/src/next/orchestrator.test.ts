import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { PeerManager, PublicApi, PeerConnection } from './orchestrator'
import { CatalystNodeBus, ConnectionPool } from './orchestrator'
import type { PeerInfo, RouteTable } from './routing/state'
import { newRouteTable } from './routing/state'
import type { RpcStub } from 'capnweb'

// Helper to access private state for testing
interface TestBus {
    state: RouteTable
}

// Mock ConnectionPool
class MockConnectionPool extends ConnectionPool {
    get(endpoint: string) {
        // Return a mock object that satisfies whatever RpcStub<PublicApi> needs for this test
        // Key method is getPeerConnection().open()
        return {
            getPeerConnection: async (secret: string) => {
                return {
                    success: true,
                    connection: {
                        open: async (peer: PeerInfo) => {
                            return { success: true }
                        },
                        close: async (peer: PeerInfo, code: number, reason?: string) => {
                            return { success: true }
                        }
                    }
                }
            }
        } as unknown as RpcStub<PublicApi>
    }
}

describe('CatalystNodeBus', () => {
    let bus: CatalystNodeBus

    beforeEach(() => {
        bus = new CatalystNodeBus({
            state: newRouteTable(),
            connectionPool: { pool: new MockConnectionPool() }
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

            const result = await bus.dispatch({
                action: 'local:peer:create',
                data: peer,
            })

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

            await bus.dispatch({
                action: 'local:peer:create',
                data: peer,
            })

            const result = await bus.dispatch({
                action: 'local:peer:create',
                data: peer,
            })

            expect(result).toEqual({ success: false, error: 'Peer already exists' })
        })
    })

    describe('local:peer:update', () => {
        beforeEach(async () => {
            await bus.dispatch({
                action: 'local:peer:create',
                data: {
                    name: 'peer1',
                    endpoint: 'http://localhost:8080',
                    domains: ['example.com'],
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
                data: updateData,
            })

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
            const result = await bus.dispatch({
                action: 'local:peer:update',
                data: {
                    name: 'non-existent',
                    endpoint: '...',
                    domains: [],
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
                    name: 'peer1',
                    endpoint: 'http://localhost:8080',
                    domains: ['example.com'],
                },
            })
        })

        it('should remove an existing peer', async () => {
            const result = await bus.dispatch({
                action: 'local:peer:delete',
                data: {
                    name: 'peer1',
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
                    name: 'non-existent',
                },
            })

            expect(result).toEqual({ success: false, error: 'Peer not found' })
        })
    })

    describe('Public API', () => {
        let api: PeerManager

        beforeEach(() => {
            // Re-instantiate with mock pool for Public API tests too
            // Note: PublicApi implementation in catalystNodeBus just dispatches actions
            // so mocking the pool in constructor is sufficient.
            bus = new CatalystNodeBus({
                state: newRouteTable(),
                connectionPool: { pool: new MockConnectionPool() }
            })
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
            expect(state.internal.peers[0].connectionStatus).toBe('connected')
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

    describe('internal:protocol:connected', () => {
        it('should transition peer to connected state', async () => {
            // 1. Configure peer (initially initializing)
            await bus.dispatch({
                action: 'local:peer:create',
                data: {
                    name: 'connecting-peer',
                    endpoint: 'http://connecting.com',
                    domains: [],
                },
            })

            // Manually force to initializing if create didn't leave it there (it does, but handleNotify -> open -> connected sequence happens fast in test)
            // Actually, since handleNotify is awaited, state is already connected. 
            // So we need to cheat to test the action handler in isolation? 
            // OR we rely on the fact that dispatch('internal:protocol:connected') is what does it.

            // Let's manually set it to initializing to verify the handler specifically
            const state = (bus as unknown as TestBus).state
            state.internal.peers[0].connectionStatus = 'initializing'

            const result = await bus.dispatch({
                action: 'internal:protocol:connected',
                data: {
                    peerInfo: {
                        name: 'connecting-peer',
                        endpoint: 'http://connecting.com',
                        domains: [],
                    }
                }
            })

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
            await bus.dispatch({
                action: 'local:peer:create',
                data: peerInfo,
            })

            const state = (bus as unknown as TestBus).state
            const peer = state.internal.peers.find(p => p.name === 'handshake-peer')
            expect(peer).toBeDefined()
            expect(peer?.connectionStatus).toBe('connected')

            // 2. Remote side closes (internal:protocol:close)
            await bus.dispatch({
                action: 'internal:protocol:close',
                data: {
                    peerInfo: peerInfo,
                    code: 1000,
                    reason: 'Done'
                }
            })

            const finalState = (bus as unknown as TestBus).state
            const peerAfterClose = finalState.internal.peers.find(p => p.name === 'handshake-peer')
            expect(peerAfterClose).toBeUndefined()
        })
    })
    describe('internal:protocol:open', () => {
        it('should accept connection if peer is configured', async () => {
            // 1. Configure peer (initially connected via mock)
            await bus.dispatch({
                action: 'local:peer:create',
                data: {
                    name: 'remote-peer',
                    endpoint: 'http://remote.com',
                    domains: [],
                },
            })

            // 2. Simulate disconnect / reset status manually for test? 
            // Or just verify it stays connected / returns success.
            // Let's manually set it to initializing to test transition
            const state = (bus as unknown as TestBus).state
            state.internal.peers[0].connectionStatus = 'initializing'

            // 3. Receive open request
            const result = await bus.dispatch({
                action: 'internal:protocol:open',
                data: {
                    peerInfo: {
                        name: 'remote-peer',
                        endpoint: 'http://remote.com',
                        domains: [],
                    }
                }
            })

            expect(result).toEqual({ success: true })
            const finalState = (bus as unknown as TestBus).state
            expect(finalState.internal.peers[0].connectionStatus).toBe('connected')
        })

        it('should reject connection if peer is not configured', async () => {
            const result = await bus.dispatch({
                action: 'internal:protocol:open',
                data: {
                    peerInfo: {
                        name: 'stranger',
                        endpoint: 'http://remote.com',
                        domains: [],
                    }
                }
            })

            expect(result).toEqual({ success: false, error: 'Peer not configured' })
        })
    })

    describe('internal:protocol:close', () => {
        it('should remove peer if configured', async () => {
            // 1. Configure peer
            await bus.dispatch({
                action: 'local:peer:create',
                data: {
                    name: 'remote-peer',
                    endpoint: 'http://remote.com',
                    domains: [],
                },
            })

            const preState = (bus as unknown as TestBus).state
            expect(preState.internal.peers).toHaveLength(1)

            // 2. Receive close request
            const result = await bus.dispatch({
                action: 'internal:protocol:close',
                data: {
                    peerInfo: {
                        name: 'remote-peer',
                        endpoint: 'http://remote.com',
                        domains: [],
                    },
                    code: 1000,
                    reason: 'Closed'
                }
            })

            expect(result).toEqual({ success: true })
            const postState = (bus as unknown as TestBus).state
            expect(postState.internal.peers).toHaveLength(0)
        })

        it('should no-op if peer is not configured', async () => {
            const result = await bus.dispatch({
                action: 'internal:protocol:close',
                data: {
                    peerInfo: {
                        name: 'stranger',
                        endpoint: 'http://remote.com',
                        domains: [],
                    },
                    code: 1000,
                    reason: 'Closed'
                }
            })

            expect(result).toEqual({ success: true })
        })
    })
})
