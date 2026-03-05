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
})
