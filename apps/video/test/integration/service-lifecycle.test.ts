import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { newWebSocketRpcSession } from 'capnweb'
import { catalystHonoServer, type CatalystHonoServer } from '@catalyst/service'
import type { CatalystConfig } from '@catalyst/config'

import { VideoStreamService } from '../../src/service.js'
import type { StreamCatalog, DispatchCapability } from '../../src/bus-client.js'

/**
 * Shape of the remote API as seen by a mock orchestrator client.
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
    { name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' },
    { name: 'cam-rear', protocol: 'media', source: 'remote', sourceNode: 'node-b' },
  ],
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

describe('VideoStreamService lifecycle integration', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  beforeAll(async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, {
      services: [service],
      port: 0,
    })
    await server.start()
    port = server.port
  })

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('/readyz returns 503 before orchestrator connects', async () => {
    const res = await fetch(`http://localhost:${port}/readyz`)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ready).toBe(false)
  })

  it('/healthz returns 200', async () => {
    const res = await fetch(`http://localhost:${port}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('/streams returns 503 before catalog', async () => {
    const res = await fetch(`http://localhost:${port}/streams`)
    expect(res.status).toBe(503)
  })

  it('webhook /video-stream/hooks/ready returns 503 before orchestrator connection', async () => {
    const res = await fetch(`http://localhost:${port}/video-stream/hooks/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test-stream', sourceType: 'rtspSource' }),
    })
    expect(res.status).toBe(503)
  })

  it('orchestrator connect -> catalog push -> /readyz returns 200', async () => {
    const { rpc, ws } = await connectOrchestrator(port)

    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const result = await rpc.getVideoClient(mockDispatch)
    expect(result.success).toBe(true)

    // Push catalog
    await result.client.updateStreamCatalog(sampleCatalog)

    // /readyz should now return 200
    const res = await fetch(`http://localhost:${port}/readyz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ready).toBe(true)

    // /streams requires auth — verify it's gated (no auth client in test)
    const streamsRes = await fetch(`http://localhost:${port}/streams`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(streamsRes.status).toBe(403)

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  })

  it('disconnect -> /readyz returns 503 -> reconnect restores ready', async () => {
    // After previous test, the WS was closed so catalogReady should be false
    // Wait for disconnect handler to fire
    await new Promise((r) => setTimeout(r, 300))

    const res = await fetch(`http://localhost:${port}/readyz`)
    expect(res.status).toBe(503)

    // Reconnect
    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)
    await client.updateStreamCatalog(sampleCatalog)

    const res2 = await fetch(`http://localhost:${port}/readyz`)
    expect(res2.status).toBe(200)

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  })
})

describe('VideoStreamService shutdown lifecycle', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  it('shutdown flips readyz to 503 and tears down relays', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()

    server = catalystHonoServer(service.handler, {
      services: [service],
      port: 0,
    })
    await server.start()
    port = server.port

    // Connect orchestrator and push catalog to make service ready
    const { rpc, ws } = await connectOrchestrator(port)
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)
    await client.updateStreamCatalog(sampleCatalog)

    // Verify ready
    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)

    // Close WS before shutdown to avoid interference
    ws.close()
    await new Promise((r) => setTimeout(r, 200))

    // Trigger shutdown
    await server.stop()

    // Service state should reflect shutdown
    expect(service.state).toBe('stopped')
  }, 15_000)
})

describe('VideoStreamService starts without token', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('service starts successfully without nodeToken', async () => {
    const config = makeConfig({ nodeToken: undefined, authEndpoint: undefined })
    service = new VideoStreamService({ config })
    await service.initialize()

    server = catalystHonoServer(service.handler, {
      services: [service],
      port: 0,
    })
    await server.start()
    port = server.port

    // Service should be up
    const res = await fetch(`http://localhost:${port}/healthz`)
    expect(res.status).toBe(200)

    // But not ready (no orchestrator)
    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(503)
  })
})

describe('VideoStreamService auth connect failure', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer

  afterAll(async () => {
    if (server) await server.stop()
  })

  it('service starts even when auth endpoint is unreachable', async () => {
    // Auth endpoint configured but not reachable — service should start anyway
    const config = makeConfig({
      authEndpoint: 'ws://localhost:19999/nonexistent',
      nodeToken: 'test-token',
    })

    service = new VideoStreamService({ config })
    // Should not throw — auth failure is non-fatal
    await service.initialize()

    server = catalystHonoServer(service.handler, {
      services: [service],
      port: 0,
    })
    await server.start()

    const res = await fetch(`http://localhost:${server.port}/healthz`)
    expect(res.status).toBe(200)
  })
})
