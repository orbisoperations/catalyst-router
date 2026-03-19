import { describe, expect, it, beforeEach } from 'vitest'
import { VideoStreamService } from '../src/service.js'
import { VideoConfigSchema } from '../src/config.js'
import type { CatalystConfig } from '@catalyst/config'
import { TelemetryBuilder } from '@catalyst/telemetry'

function makeVideoConfig(overrides: Record<string, unknown> = {}) {
  return VideoConfigSchema.parse({
    orchestratorEndpoint: 'ws://localhost:3000',
    authEndpoint: 'http://localhost:3001',
    systemToken: 'test-token',
    ...overrides,
  })
}

function makeCatalystConfig(): CatalystConfig {
  return {
    port: 3002,
    node: {
      name: 'test-node',
      domains: ['test.local'],
    },
  }
}

describe('VideoStreamService', () => {
  let telemetry: Awaited<ReturnType<typeof TelemetryBuilder.noop>>

  beforeEach(() => {
    telemetry = TelemetryBuilder.noop('video')
  })

  it('initializes in disabled mode when ENABLED=false', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig({ enabled: false })

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
    })

    expect(service.state).toBe('ready')
    expect(service.getProcessState()).toBe('disabled')
    expect(service.getControlApiClient()).toBeUndefined()

    await service.shutdown()
    expect(service.state).toBe('stopped')
  })

  it('exposes health endpoint', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig({ enabled: false })

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
    })

    const res = await service.handler.request('/health')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('disabled')

    await service.shutdown()
  })

  it('exposes root endpoint', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig({ enabled: false })

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
    })

    const res = await service.handler.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Video Service')

    await service.shutdown()
  })

  it('has correct service info', () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()

    const service = new VideoStreamService({ config, videoConfig, telemetry })
    expect(service.info.name).toBe('video')
  })

  it('shuts down cleanly in disabled mode', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig({ enabled: false })

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
    })

    await service.shutdown()
    expect(service.state).toBe('stopped')
  })
})
