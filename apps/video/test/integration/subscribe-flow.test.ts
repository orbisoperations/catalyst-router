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

function makeConfig(): CatalystConfig {
  return {
    port: 0,
    node: { name: 'test-node', domains: ['test.local'] },
    video: {
      port: 0,
      mediamtxApiUrl: 'http://localhost:19997',
      relayGracePeriodMs: 30_000,
      debounceDurationMs: 50,
      streamAuth: { legacyFallback: true },
      // No authEndpoint or nodeToken -- auth will be in fail-closed mode
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

async function pushCatalog(port: number, catalog: StreamCatalog): Promise<WebSocket> {
  const { rpc, ws } = await connectOrchestrator(port)
  const mockDispatch: DispatchCapability = {
    dispatch: vi.fn().mockResolvedValue({ success: true }),
  }
  const result = await rpc.getVideoClient(mockDispatch)
  expect(result.success).toBe(true)
  await result.client.updateStreamCatalog(catalog)
  return ws
}

describe('subscribe-flow integration', () => {
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

  it('returns 404 for unknown stream', async () => {
    const catalog: StreamCatalog = {
      streams: [{ name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' }],
    }
    const ws = await pushCatalog(port, catalog)

    try {
      const res = await fetch(`http://localhost:${port}/subscribe/cam-unknown`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toBe('Stream not found')
    } finally {
      ws.close()
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  it('returns 401 without auth header', async () => {
    const catalog: StreamCatalog = {
      streams: [{ name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' }],
    }
    const ws = await pushCatalog(port, catalog)

    try {
      const res = await fetch(`http://localhost:${port}/subscribe/cam-front`, {
        method: 'POST',
        // No Authorization header
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toBe('Authorization header required')
    } finally {
      ws.close()
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  it('returns 403 when auth denies (fail-closed, no auth configured)', async () => {
    const catalog: StreamCatalog = {
      streams: [{ name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' }],
    }
    const ws = await pushCatalog(port, catalog)

    try {
      const res = await fetch(`http://localhost:${port}/subscribe/cam-front`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      })
      // Auth is not configured so evaluate() returns { success: false, errorType: 'auth_unavailable' }
      // errorType is 'auth_unavailable' (not 'POLICY_UNAVAILABLE'), so legacyFallback does NOT trigger.
      // The endpoint should return 403.
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toBe('Forbidden')
    } finally {
      ws.close()
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  it('streams endpoint requires auth (403 without auth client)', async () => {
    const catalog: StreamCatalog = {
      streams: [
        { name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' },
        { name: 'cam-rear', protocol: 'media', source: 'remote', sourceNode: 'node-b' },
        { name: 'cam-side', protocol: 'media', source: 'local', sourceNode: 'test-node' },
      ],
    }
    const ws = await pushCatalog(port, catalog)

    try {
      // No auth header → 401
      const noAuthRes = await fetch(`http://localhost:${port}/streams`)
      expect(noAuthRes.status).toBe(401)

      // With token but no auth client configured → 403 (fail-closed)
      const res = await fetch(`http://localhost:${port}/streams`, {
        headers: { Authorization: 'Bearer test-token' },
      })
      expect(res.status).toBe(403)
    } finally {
      ws.close()
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  it('streams endpoint returns 503 before catalog push', async () => {
    // Use a fresh service instance with no orchestrator connected
    const config = makeConfig()
    const freshService = new VideoStreamService({ config })
    await freshService.initialize()
    const freshServer = catalystHonoServer(freshService.handler, {
      services: [freshService],
      port: 0,
    })
    await freshServer.start()

    try {
      const res = await fetch(`http://localhost:${freshServer.port}/streams`)
      expect(res.status).toBe(503)
    } finally {
      await freshServer.stop()
    }
  })
})
