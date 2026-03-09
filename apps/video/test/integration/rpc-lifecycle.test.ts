import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { newWebSocketRpcSession } from 'capnweb'
import { catalystHonoServer } from '@catalyst/service'

import {
  VideoBusClient,
  type StreamCatalog,
  type DispatchCapability,
} from '../../src/bus-client.js'
import { VideoRpcServer, type VideoRpcServerDeps } from '../../src/rpc-server.js'
import { createVideoRpcHandler } from '../../src/rpc-handler.js'

/**
 * Shape of the remote API as seen by the orchestrator client.
 * This mirrors what VideoRpcServer exposes via capnweb.
 */
interface VideoRpcApi {
  getVideoClient(dispatch: DispatchCapability): Promise<{
    success: true
    client: {
      updateStreamCatalog(catalog: StreamCatalog): Promise<void>
      refreshToken(token: string): Promise<void>
    }
  }>
}

const sampleCatalog: StreamCatalog = {
  streams: [
    { name: 'cam-front', protocol: 'rtsp', source: 'local', sourceNode: 'node-a' },
    { name: 'cam-rear', protocol: 'rtsp', source: 'remote', sourceNode: 'node-b' },
  ],
}

describe('RPC lifecycle integration', () => {
  let server: ReturnType<typeof catalystHonoServer>
  let port: number
  let busClient: VideoBusClient
  let deps: VideoRpcServerDeps

  const onCatalogUpdate = vi.fn().mockResolvedValue(undefined)
  const onCatalogReady = vi.fn()
  const onCatalogLost = vi.fn()
  const onTokenRefresh = vi.fn().mockResolvedValue(undefined)

  beforeAll(async () => {
    busClient = new VideoBusClient()
    deps = {
      busClient,
      onCatalogUpdate,
      onCatalogReady,
      onCatalogLost,
      onTokenRefresh,
    }
    const rpcServer = new VideoRpcServer(deps)
    const app = createVideoRpcHandler(rpcServer)

    server = catalystHonoServer(app, { port: 0 })
    await server.start()
    port = server.port
  })

  afterAll(async () => {
    if (server) await server.stop()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function connectClient(): Promise<{ rpc: VideoRpcApi; ws: WebSocket }> {
    const ws = new WebSocket(`ws://localhost:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(e))
    })
    const rpc = newWebSocketRpcSession<VideoRpcApi>(ws as unknown as WebSocket)
    return { rpc, ws }
  }

  it('orchestrator connects, exchanges capabilities, and pushes catalog', async () => {
    const { rpc, ws } = await connectClient()

    // Orchestrator provides its dispatch capability and receives video capabilities
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const result = await rpc.getVideoClient(mockDispatch)
    expect(result.success).toBe(true)
    expect(busClient.hasDispatch).toBe(true)

    // Push catalog
    await result.client.updateStreamCatalog(sampleCatalog)
    expect(busClient.catalog.streams).toHaveLength(2)
    expect(onCatalogReady).toHaveBeenCalledTimes(1)
    expect(onCatalogUpdate).toHaveBeenCalledWith(sampleCatalog)

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  })

  it('capability exchange stores dispatch in busClient', async () => {
    const { rpc, ws } = await connectClient()

    const mockDispatchFn = vi.fn().mockResolvedValue({ success: true })
    const dispatch: DispatchCapability = { dispatch: mockDispatchFn }
    const result = await rpc.getVideoClient(dispatch)

    // Capability exchange succeeded
    expect(result.success).toBe(true)
    // Dispatch capability was stored in busClient
    expect(busClient.hasDispatch).toBe(true)

    // NOTE: Dispatch round-trip through capnweb RPC requires localMain-based
    // capability exchange (not parameter passing). capnweb releases parameter
    // imports after the call returns. The actual dispatch round-trip is tested
    // at the unit level in rpc-server.test.ts and will be wired with the
    // correct localMain pattern in T063 (service lifecycle wiring).

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  })

  it('orchestrator can refresh token via RPC', async () => {
    const { rpc, ws } = await connectClient()

    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)

    await client.refreshToken('new-system-token')
    expect(onTokenRefresh).toHaveBeenCalledWith('new-system-token')

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  })

  it('disconnect clears dispatch and fires onCatalogLost', async () => {
    const { rpc, ws } = await connectClient()

    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    await rpc.getVideoClient(mockDispatch)
    expect(busClient.hasDispatch).toBe(true)

    // Close the WebSocket — should trigger handleDisconnect
    ws.close()
    await new Promise((r) => setTimeout(r, 200))

    expect(busClient.hasDispatch).toBe(false)
    expect(onCatalogLost).toHaveBeenCalledTimes(1)
  })

  it('reconnect after disconnect re-exchanges capabilities and re-fires catalogReady', async () => {
    // First connection
    const { rpc: rpc1, ws: ws1 } = await connectClient()
    const dispatch1: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client: client1 } = await rpc1.getVideoClient(dispatch1)
    await client1.updateStreamCatalog(sampleCatalog)
    const readyCountAfterFirst = onCatalogReady.mock.calls.length

    // Disconnect
    ws1.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(busClient.hasDispatch).toBe(false)

    // Reconnect with fresh dispatch capability
    const { rpc: rpc2, ws: ws2 } = await connectClient()
    const dispatch2: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client: client2 } = await rpc2.getVideoClient(dispatch2)
    expect(busClient.hasDispatch).toBe(true)

    // Push catalog again — should fire onCatalogReady again (new connection)
    await client2.updateStreamCatalog(sampleCatalog)
    expect(onCatalogReady.mock.calls.length).toBe(readyCountAfterFirst + 1)

    ws2.close()
    await new Promise((r) => setTimeout(r, 200))
  })
})
