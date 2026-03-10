import { describe, it, expect, vi, afterAll } from 'vitest'
import { newWebSocketRpcSession } from 'capnweb'
import { catalystHonoServer, type CatalystHonoServer } from '@catalyst/service'
import type { CatalystConfig } from '@catalyst/config'

import { VideoStreamService } from '../../src/service.js'
import type { StreamCatalog, DispatchCapability } from '../../src/bus-client.js'
import type { VideoAuthService } from '../../src/video-auth.js'

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
    { name: 'cam-side', protocol: 'media', source: 'local', sourceNode: 'test-node' },
  ],
}

function makeConfig(): CatalystConfig {
  return {
    port: 0,
    node: { name: 'test-node', domains: ['test.local'] },
    video: {
      port: 0,
      mediamtxApiUrl: 'http://localhost:19997',
      relayGracePeriodMs: 30_000,
      debounceDurationMs: 50,
      streamAuth: { legacyFallback: false },
    },
  }
}

async function connectAndPushCatalog(port: number, catalog: StreamCatalog): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/api`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(e))
  })
  const rpc = newWebSocketRpcSession<VideoRpcApi>(ws as unknown as WebSocket)
  const mockDispatch: DispatchCapability = {
    dispatch: vi.fn().mockResolvedValue({ success: true }),
  }
  const { client } = await rpc.getVideoClient(mockDispatch)
  await client.updateStreamCatalog(catalog)
  return ws
}

/**
 * Replace the private videoAuth on a service instance with a mock.
 * The authDelegate in service.ts reads this.videoAuth dynamically,
 * so swapping it after init takes effect immediately.
 */
function injectAuth(service: VideoStreamService, mock: VideoAuthService): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(service as any).videoAuth = mock
}

function allowAllAuth(): VideoAuthService {
  return {
    evaluate: vi.fn(async () => ({ success: true as const, allowed: true })),
  }
}

function denyAllAuth(): VideoAuthService {
  return {
    evaluate: vi.fn(async () => ({
      success: false as const,
      errorType: 'AUTHZ_DENY',
      reason: 'denied by test',
    })),
  }
}

// ---------------------------------------------------------------------------
// Tests: /streams auth + catalog happy path
// ---------------------------------------------------------------------------

describe('/streams auth integration', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number
  let ws: WebSocket

  afterAll(async () => {
    ws?.close()
    await new Promise((r) => setTimeout(r, 200))
    if (server) await server.stop()
  })

  it('setup: start service and push catalog', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()
    server = catalystHonoServer(service.handler, { services: [service], port: 0 })
    await server.start()
    port = server.port

    ws = await connectAndPushCatalog(port, sampleCatalog)

    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)
  })

  it('returns 503 before catalog is ready', async () => {
    const freshConfig = makeConfig()
    const freshService = new VideoStreamService({ config: freshConfig })
    await freshService.initialize()
    const freshServer = catalystHonoServer(freshService.handler, {
      services: [freshService],
      port: 0,
    })
    await freshServer.start()

    try {
      const res = await fetch(`http://localhost:${freshServer.port}/streams`, {
        headers: { Authorization: 'Bearer test-token' },
      })
      expect(res.status).toBe(503)
    } finally {
      await freshServer.stop()
    }
  })

  it('returns 401 without Authorization header', async () => {
    injectAuth(service, allowAllAuth())
    const res = await fetch(`http://localhost:${port}/streams`)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Authorization header required')
  })

  it('returns 403 when auth denies', async () => {
    injectAuth(service, denyAllAuth())
    const res = await fetch(`http://localhost:${port}/streams`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
  })

  it('returns catalog data when auth allows', async () => {
    injectAuth(service, allowAllAuth())
    const res = await fetch(`http://localhost:${port}/streams`, {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.streams).toHaveLength(3)
    const names = body.streams.map((s: { name: string }) => s.name)
    expect(names).toContain('cam-front')
    expect(names).toContain('cam-rear')
    expect(names).toContain('cam-side')
  })

  it('filters by scope=local', async () => {
    injectAuth(service, allowAllAuth())
    const res = await fetch(`http://localhost:${port}/streams?scope=local`, {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.streams).toHaveLength(2)
    expect(body.streams.every((s: { source: string }) => s.source === 'local')).toBe(true)
  })

  it('filters by sourceNode', async () => {
    injectAuth(service, allowAllAuth())
    const res = await fetch(`http://localhost:${port}/streams?sourceNode=node-b`, {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0].name).toBe('cam-rear')
  })

  it('evaluates auth with STREAM_DISCOVER action', async () => {
    const mockAuth = allowAllAuth()
    injectAuth(service, mockAuth)
    await fetch(`http://localhost:${port}/streams`, {
      headers: { Authorization: 'Bearer my-token' },
    })
    expect(mockAuth.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'my-token',
        action: 'STREAM_DISCOVER',
        nodeContext: { nodeId: 'test-node', domains: ['test.local'] },
      })
    )
  })
})
