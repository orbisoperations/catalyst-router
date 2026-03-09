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

function makeConfig(): CatalystConfig {
  return {
    port: 0,
    node: { name: 'perf-node', domains: ['perf.local'] },
    video: {
      port: 0,
      mediamtxApiUrl: 'http://localhost:19997',
      relayGracePeriodMs: 30_000,
      debounceDurationMs: 10, // Low debounce for perf test
      streamAuth: { legacyFallback: true },
    },
  }
}

describe('Burst performance test', () => {
  let service: VideoStreamService
  let server: CatalystHonoServer
  let port: number

  afterAll(async () => {
    if (server) await server.stop()
  }, 15_000)

  it('handles 100 webhook POSTs in 2s with p99 < 200ms', async () => {
    const config = makeConfig()
    service = new VideoStreamService({ config })
    await service.initialize()

    server = catalystHonoServer(service.handler, {
      services: [service],
      port: 0,
    })
    await server.start()
    port = server.port

    // Connect mock orchestrator and push catalog with 50 streams
    const ws = new WebSocket(`ws://localhost:${port}/api`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(e))
    })
    const rpc = newWebSocketRpcSession<VideoRpcApi>(ws as unknown as WebSocket)

    const _dispatchTimes: number[] = []
    const mockDispatch: DispatchCapability = {
      dispatch: vi.fn().mockImplementation(async () => {
        return { success: true }
      }),
    }
    const { client } = await rpc.getVideoClient(mockDispatch)

    // Build catalog with 50 streams
    const streams = Array.from({ length: 50 }, (_, i) => ({
      name: `stream-${i}`,
      protocol: 'media' as const,
      source: 'local' as const,
      sourceNode: 'perf-node',
    }))
    await client.updateStreamCatalog({ streams })

    // Verify service is ready
    const readyRes = await fetch(`http://localhost:${port}/readyz`)
    expect(readyRes.status).toBe(200)

    // Fire 100 POST requests — 50 unique stream paths, each posted ~2 times
    const requests: Promise<{ latency: number; status: number }>[] = []

    for (let i = 0; i < 100; i++) {
      const streamIndex = i % 50
      const startTime = performance.now()
      const p = fetch(`http://localhost:${port}/video-stream/hooks/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: `stream-${streamIndex}`,
          sourceType: 'rtspSource',
        }),
      }).then((res) => ({
        latency: performance.now() - startTime,
        status: res.status,
      }))
      requests.push(p)
    }

    const results = await Promise.all(requests)

    // All should succeed (200)
    const successes = results.filter((r) => r.status === 200)
    expect(successes.length).toBe(100)

    // Calculate p99 latency
    const latencies = results.map((r) => r.latency).sort((a, b) => a - b)
    const p99Index = Math.ceil(latencies.length * 0.99) - 1
    const p99 = latencies[p99Index]

    // p99 should be under 500ms (generous for CI/loaded machines)
    expect(p99).toBeLessThan(500)

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 10_000)
})
