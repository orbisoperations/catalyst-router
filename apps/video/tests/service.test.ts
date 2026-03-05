import { describe, it, expect } from 'vitest'
import { VideoService } from '../src/service.js'
import type { CatalystConfig } from '@catalyst/config'

const baseConfig: CatalystConfig = {
  node: { name: 'test-node.somebiz.local.io', domains: ['somebiz.local.io'] },
  port: 3000,
}

describe('VideoService', () => {
  it('creates and initializes successfully', async () => {
    const service = await VideoService.create({ config: baseConfig })
    expect(service.state).toBe('ready')
    expect(service.info.name).toBe('video')
  })

  it('shuts down cleanly', async () => {
    const service = await VideoService.create({ config: baseConfig })
    expect(service.state).toBe('ready')
    await service.shutdown()
    expect(service.state).toBe('stopped')
  })

  it('mounts expected routes on handler', async () => {
    const service = await VideoService.create({ config: baseConfig })
    const routes = service.handler.routes
    const paths = routes.map((r) => r.path)
    expect(paths).toContain('/api')
    expect(paths.some((p) => p.startsWith('/video-stream'))).toBe(true)
  })

  it('returns 400 for invalid source query param', async () => {
    const service = await VideoService.create({ config: baseConfig })
    const res = await service.handler.request('/video-stream/streams?source=Remote')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid source filter')
  })

  it('returns 200 for valid source query params', async () => {
    const service = await VideoService.create({ config: baseConfig })
    for (const source of ['local', 'remote', 'all']) {
      const res = await service.handler.request(`/video-stream/streams?source=${source}`)
      expect(res.status).toBe(200)
    }
  })

  it('mounts lifecycle hook endpoints and updates local stream state', async () => {
    const service = await VideoService.create({ config: baseConfig })

    const readyRes = await service.handler.request('/video-stream/hooks/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'cam-front', sourceType: 'rtspSource' }),
    })
    expect(readyRes.status).toBe(200)

    const localAfterReady = await service.handler.request('/video-stream/streams?source=local')
    const readyBody = await localAfterReady.json()
    expect(readyBody.streams).toHaveLength(1)
    expect(readyBody.streams[0].name).toBe('test-node.somebiz.local.io/cam-front')
    expect(readyBody.streams[0].protocols.rtsp).toBe('rtsp://localhost:8554/cam-front')

    const notReadyRes = await service.handler.request('/video-stream/hooks/not-ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'cam-front' }),
    })
    expect(notReadyRes.status).toBe(200)

    const localAfterNotReady = await service.handler.request('/video-stream/streams?source=local')
    const notReadyBody = await localAfterNotReady.json()
    expect(notReadyBody.streams).toHaveLength(0)
  })
})
