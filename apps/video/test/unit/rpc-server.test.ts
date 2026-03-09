import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  VideoBusClient,
  type StreamCatalog,
  type DispatchCapability,
} from '../../src/bus-client.js'
import { VideoRpcServer, type VideoRpcServerDeps } from '../../src/rpc-server.js'

function makeDeps(overrides?: Partial<VideoRpcServerDeps>): VideoRpcServerDeps {
  return {
    busClient: new VideoBusClient(),
    onCatalogUpdate: vi.fn().mockResolvedValue(undefined),
    onCatalogReady: vi.fn(),
    onCatalogLost: vi.fn(),
    onTokenRefresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function mockDispatch(): DispatchCapability {
  return { dispatch: vi.fn().mockResolvedValue({ success: true }) }
}

const sampleCatalog: StreamCatalog = {
  streams: [
    { name: 'cam-front', protocol: 'rtsp', source: 'local', sourceNode: 'node-a' },
    { name: 'cam-rear', protocol: 'rtsp', source: 'remote', sourceNode: 'node-b' },
  ],
}

describe('VideoRpcServer', () => {
  let deps: VideoRpcServerDeps
  let server: VideoRpcServer

  beforeEach(() => {
    deps = makeDeps()
    server = new VideoRpcServer(deps)
  })

  describe('getVideoClient', () => {
    it('stores the dispatch capability on the bus client', async () => {
      const dispatch = mockDispatch()
      await server.getVideoClient(dispatch)
      expect(deps.busClient.hasDispatch).toBe(true)
    })

    it('returns success with updateStreamCatalog and refreshToken capabilities', async () => {
      const result = await server.getVideoClient(mockDispatch())
      expect(result.success).toBe(true)
      expect(typeof result.client.updateStreamCatalog).toBe('function')
      expect(typeof result.client.refreshToken).toBe('function')
    })
  })

  describe('updateStreamCatalog', () => {
    it('updates the catalog on the bus client', async () => {
      const { client } = await server.getVideoClient(mockDispatch())
      await client.updateStreamCatalog(sampleCatalog)

      expect(deps.busClient.catalog).toEqual(sampleCatalog)
    })

    it('calls onCatalogUpdate callback', async () => {
      const { client } = await server.getVideoClient(mockDispatch())
      await client.updateStreamCatalog(sampleCatalog)

      expect(deps.onCatalogUpdate).toHaveBeenCalledWith(sampleCatalog)
    })

    it('calls onCatalogReady on first catalog push only', async () => {
      const { client } = await server.getVideoClient(mockDispatch())

      await client.updateStreamCatalog(sampleCatalog)
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(1)

      // Second push should not fire onCatalogReady again
      await client.updateStreamCatalog({ streams: [] })
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(1)
    })

    it('calls onCatalogUpdate for every push', async () => {
      const { client } = await server.getVideoClient(mockDispatch())

      await client.updateStreamCatalog(sampleCatalog)
      await client.updateStreamCatalog({ streams: [] })

      expect(deps.onCatalogUpdate).toHaveBeenCalledTimes(2)
    })

    it('works without optional callbacks', async () => {
      const minimal = makeDeps({
        onCatalogUpdate: undefined,
        onCatalogReady: undefined,
      })
      const minServer = new VideoRpcServer(minimal)
      const { client } = await minServer.getVideoClient(mockDispatch())

      // Should not throw
      await client.updateStreamCatalog(sampleCatalog)
      expect(minimal.busClient.catalog).toEqual(sampleCatalog)
    })
  })

  describe('refreshToken', () => {
    it('calls onTokenRefresh with the token', async () => {
      const { client } = await server.getVideoClient(mockDispatch())
      await client.refreshToken('new-jwt-token')

      expect(deps.onTokenRefresh).toHaveBeenCalledWith('new-jwt-token')
    })

    it('works without optional callback', async () => {
      const minimal = makeDeps({ onTokenRefresh: undefined })
      const minServer = new VideoRpcServer(minimal)
      const { client } = await minServer.getVideoClient(mockDispatch())

      // Should not throw
      await client.refreshToken('new-jwt-token')
    })
  })

  describe('handleDisconnect', () => {
    it('clears the dispatch capability on the bus client', async () => {
      await server.getVideoClient(mockDispatch())
      expect(deps.busClient.hasDispatch).toBe(true)

      server.handleDisconnect()
      expect(deps.busClient.hasDispatch).toBe(false)
    })

    it('calls onCatalogLost', async () => {
      await server.getVideoClient(mockDispatch())
      server.handleDisconnect()

      expect(deps.onCatalogLost).toHaveBeenCalledTimes(1)
    })

    it('resets catalogReady so reconnect fires onCatalogReady again', async () => {
      // First connection: push catalog
      const { client: client1 } = await server.getVideoClient(mockDispatch())
      await client1.updateStreamCatalog(sampleCatalog)
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(1)

      // Disconnect
      server.handleDisconnect()
      expect(deps.onCatalogLost).toHaveBeenCalledTimes(1)

      // Reconnect: push catalog again
      const { client: client2 } = await server.getVideoClient(mockDispatch())
      await client2.updateStreamCatalog(sampleCatalog)
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(2)
    })

    it('works without optional callbacks', () => {
      const minimal = makeDeps({ onCatalogLost: undefined })
      const minServer = new VideoRpcServer(minimal)

      // Should not throw
      minServer.handleDisconnect()
    })
  })

  describe('full lifecycle: connect -> catalog -> disconnect -> reconnect', () => {
    it('exercises the complete orchestrator lifecycle', async () => {
      // 1. Orchestrator connects and exchanges capabilities
      const dispatch1 = mockDispatch()
      const result1 = await server.getVideoClient(dispatch1)
      expect(result1.success).toBe(true)
      expect(deps.busClient.hasDispatch).toBe(true)

      // 2. Orchestrator pushes initial catalog
      await result1.client.updateStreamCatalog(sampleCatalog)
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(1)
      expect(deps.busClient.catalog.streams).toHaveLength(2)

      // 3. Orchestrator pushes updated catalog
      const updatedCatalog: StreamCatalog = {
        streams: [
          ...sampleCatalog.streams,
          { name: 'cam-side', protocol: 'rtsp', source: 'local', sourceNode: 'node-a' },
        ],
      }
      await result1.client.updateStreamCatalog(updatedCatalog)
      expect(deps.busClient.catalog.streams).toHaveLength(3)
      // onCatalogReady should NOT fire again
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(1)

      // 4. Orchestrator refreshes token
      await result1.client.refreshToken('refreshed-token')
      expect(deps.onTokenRefresh).toHaveBeenCalledWith('refreshed-token')

      // 5. Orchestrator disconnects
      server.handleDisconnect()
      expect(deps.busClient.hasDispatch).toBe(false)
      expect(deps.onCatalogLost).toHaveBeenCalledTimes(1)

      // 6. Orchestrator reconnects with new dispatch capability
      const dispatch2 = mockDispatch()
      const result2 = await server.getVideoClient(dispatch2)
      expect(result2.success).toBe(true)
      expect(deps.busClient.hasDispatch).toBe(true)

      // 7. Orchestrator re-pushes catalog — onCatalogReady fires again
      await result2.client.updateStreamCatalog(sampleCatalog)
      expect(deps.onCatalogReady).toHaveBeenCalledTimes(2)
    })
  })
})
