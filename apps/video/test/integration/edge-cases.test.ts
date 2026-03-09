import { describe, it, expect, vi, afterAll } from 'vitest'
import { newWebSocketRpcSession } from 'capnweb'
import { catalystHonoServer, type CatalystHonoServer } from '@catalyst/service'
import type { CatalystConfig } from '@catalyst/config'

import { VideoStreamService } from '../../src/service.js'
import type { StreamCatalog, DispatchCapability } from '../../src/bus-client.js'

interface VideoRpcApi {
  getVideoClient(dispatch: DispatchCapability): Promise<{
    success: true
    client: {
      updateStreamCatalog(catalog: StreamCatalog): Promise<void>
      refreshToken(token: string): Promise<void>
    }
  }>
}

function makeConfig(overrides: Partial<CatalystConfig['video']> = {}): CatalystConfig {
  return {
    port: 0,
    node: { name: 'test-node', domains: ['test.local'] },
    video: {
      port: 0,
      mediamtxApiUrl: 'http://localhost:19997',
      relayGracePeriodMs: 30_000,
      debounceDurationMs: 50,
      streamAuth: { legacyFallback: true },
      ...overrides,
    },
  }
}

async function connectOrchestrator(port: number): Promise<{ rpc: VideoRpcApi; ws: WebSocket }> {
  const ws = new WebSocket(`ws://localhost:${port}/api`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(e))
  })
  const rpc = newWebSocketRpcSession<VideoRpcApi>(ws as unknown as WebSocket)
  return { rpc, ws }
}

const sampleCatalog: StreamCatalog = {
  streams: [
    { name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' },
    { name: 'cam-rear', protocol: 'media', source: 'remote', sourceNode: 'node-b' },
  ],
}

// ---------------------------------------------------------------------------
// 1. Rapid connect/disconnect cycle
// ---------------------------------------------------------------------------
describe('Edge case: rapid connect/disconnect cycle', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('survives 5 rapid connect/catalog/disconnect cycles with consistent final state', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()
    port = server.port

    for (let i = 0; i < 5; i++) {
      const { rpc, ws } = await connectOrchestrator(port)
      const mockDispatch: DispatchCapability = {
        dispatch: vi.fn().mockResolvedValue({ success: true }),
      }
      const { client } = await rpc.getVideoClient(mockDispatch)
      await client.updateStreamCatalog(sampleCatalog)
      ws.close()
      // Brief pause to let disconnect handler fire
      await new Promise((r) => setTimeout(r, 150))
    }

    // Final connection to establish steady state
    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)
    await client.updateStreamCatalog(sampleCatalog)

    // Verify final state is consistent
    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)
    const readyBody = await readyRes.json()
    expect(readyBody.ready).toBe(true)

    const streamsRes = await fetch(`http://localhost:${port}/streams`)
    const streamsBody = await streamsRes.json()
    expect(streamsBody.streams).toHaveLength(2)
    expect(streamsBody.streams[0].name).toBe('cam-front')
    expect(streamsBody.streams[1].name).toBe('cam-rear')

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 2. Webhook during disconnect
// ---------------------------------------------------------------------------
describe('Edge case: webhook POST immediately after WS disconnect', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('returns 503 (not 500 or crash) when webhook fires after orchestrator disconnect', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()
    port = server.port

    // Connect, push catalog, then disconnect
    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)
    await client.updateStreamCatalog(sampleCatalog)

    // Close WS and immediately fire webhook (race the disconnect handler)
    ws.close()

    const webhookRes = await fetch(`http://localhost:${port}/video-stream/hooks/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'cam-front', sourceType: 'rtspSource' }),
    })

    // Should get 503 (service not ready) -- not 500 (crash)
    expect(webhookRes.status).toBe(503)

    await new Promise((r) => setTimeout(r, 200))
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 3. Double shutdown safety
// ---------------------------------------------------------------------------
describe('Edge case: double shutdown', () => {
  it('calling server.stop() twice does not crash', async () => {
    const config = makeConfig()
    const service = new VideoStreamService({ config })
    await service.initialize()
    const server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()

    // First stop should succeed
    await server.stop()

    // Second stop should not throw
    await expect(server.stop()).resolves.not.toThrow()
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 4. Empty catalog push
// ---------------------------------------------------------------------------
describe('Edge case: empty catalog', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('empty streams array results in 200 readyz and empty /streams response', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()
    port = server.port

    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)

    // Push empty catalog
    await client.updateStreamCatalog({ streams: [] })

    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)
    const readyBody = await readyRes.json()
    expect(readyBody.ready).toBe(true)

    const streamsRes = await fetch(`http://localhost:${port}/streams`)
    const streamsBody = await streamsRes.json()
    expect(streamsBody.streams).toEqual([])

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 5. Large catalog (500 streams)
// ---------------------------------------------------------------------------
describe('Edge case: large catalog (500 streams)', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('handles a catalog with 500 streams correctly', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()
    port = server.port

    // Generate 500 streams
    const largeCatalog: StreamCatalog = {
      streams: Array.from({ length: 500 }, (_, i) => ({
        name: `cam-${String(i).padStart(4, '0')}`,
        protocol: 'media',
        source: (i % 2 === 0 ? 'local' : 'remote') as 'local' | 'remote',
        sourceNode: `node-${i % 10}`,
      })),
    }

    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)
    await client.updateStreamCatalog(largeCatalog)

    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)

    const streamsRes = await fetch(`http://localhost:${port}/streams`)
    const streamsBody = await streamsRes.json()
    expect(streamsBody.streams).toHaveLength(500)

    // Spot-check first and last entries
    expect(streamsBody.streams[0].name).toBe('cam-0000')
    expect(streamsBody.streams[499].name).toBe('cam-0499')

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)
})
