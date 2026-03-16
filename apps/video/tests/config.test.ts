import { afterEach, describe, expect, it } from 'vitest'
import { VideoConfigSchema, loadVideoConfig } from '../src/config.js'

describe('VideoConfigSchema', () => {
  it('parses valid config with all defaults', () => {
    const config = VideoConfigSchema.parse({
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })

    expect(config.enabled).toBe(false)
    expect(config.rtspPort).toBe(8554)
    expect(config.rtmpPort).toBe(1935)
    expect(config.hlsPort).toBe(8888)
    expect(config.apiPort).toBe(9997)
    expect(config.metricsPort).toBe(9998)
    expect(config.maxStreams).toBe(100)
    expect(config.authFailPublish).toBe('closed')
    expect(config.sourceOnDemandStartTimeout).toBe('10s')
    expect(config.sourceOnDemandCloseAfter).toBe('10s')
    expect(config.advertiseAddress).toBeUndefined()
  })

  it('accepts custom port values', () => {
    const config = VideoConfigSchema.parse({
      rtspPort: 9554,
      rtmpPort: 2935,
      hlsPort: 9888,
      apiPort: 9998,
      metricsPort: 9999,
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })

    expect(config.rtspPort).toBe(9554)
    expect(config.rtmpPort).toBe(2935)
    expect(config.hlsPort).toBe(9888)
    expect(config.apiPort).toBe(9998)
    expect(config.metricsPort).toBe(9999)
  })

  it('rejects port out of range', () => {
    expect(() =>
      VideoConfigSchema.parse({
        rtspPort: 0,
        orchestratorEndpoint: 'ws://localhost:3000',
        authEndpoint: 'http://localhost:3001',
        systemToken: 'test-token',
      })
    ).toThrow()

    expect(() =>
      VideoConfigSchema.parse({
        rtspPort: 70000,
        orchestratorEndpoint: 'ws://localhost:3000',
        authEndpoint: 'http://localhost:3001',
        systemToken: 'test-token',
      })
    ).toThrow()
  })

  it('rejects maxStreams less than 1', () => {
    expect(() =>
      VideoConfigSchema.parse({
        maxStreams: 0,
        orchestratorEndpoint: 'ws://localhost:3000',
        authEndpoint: 'http://localhost:3001',
        systemToken: 'test-token',
      })
    ).toThrow()
  })

  it('rejects invalid authFailPublish value', () => {
    expect(() =>
      VideoConfigSchema.parse({
        authFailPublish: 'maybe',
        orchestratorEndpoint: 'ws://localhost:3000',
        authEndpoint: 'http://localhost:3001',
        systemToken: 'test-token',
      })
    ).toThrow()
  })

  it('requires orchestratorEndpoint', () => {
    expect(() =>
      VideoConfigSchema.parse({
        authEndpoint: 'http://localhost:3001',
        systemToken: 'test-token',
      })
    ).toThrow()
  })

  it('requires authEndpoint', () => {
    expect(() =>
      VideoConfigSchema.parse({
        orchestratorEndpoint: 'ws://localhost:3000',
        systemToken: 'test-token',
      })
    ).toThrow()
  })

  it('requires systemToken', () => {
    expect(() =>
      VideoConfigSchema.parse({
        orchestratorEndpoint: 'ws://localhost:3000',
        authEndpoint: 'http://localhost:3001',
      })
    ).toThrow()
  })

  it('accepts enabled=true with advertiseAddress', () => {
    const config = VideoConfigSchema.parse({
      enabled: true,
      advertiseAddress: '10.0.1.5',
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })

    expect(config.enabled).toBe(true)
    expect(config.advertiseAddress).toBe('10.0.1.5')
  })

  it('accepts authFailPublish=open', () => {
    const config = VideoConfigSchema.parse({
      authFailPublish: 'open',
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })

    expect(config.authFailPublish).toBe('open')
  })

  it('accepts port at lower boundary (1)', () => {
    const config = VideoConfigSchema.parse({
      rtspPort: 1,
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })
    expect(config.rtspPort).toBe(1)
  })

  it('accepts port at upper boundary (65535)', () => {
    const config = VideoConfigSchema.parse({
      rtspPort: 65535,
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })
    expect(config.rtspPort).toBe(65535)
  })

  it('accepts timeout with unit suffix', () => {
    const config = VideoConfigSchema.parse({
      sourceOnDemandStartTimeout: '30s',
      sourceOnDemandCloseAfter: '60s',
      orchestratorEndpoint: 'ws://localhost:3000',
      authEndpoint: 'http://localhost:3001',
      systemToken: 'test-token',
    })
    expect(config.sourceOnDemandStartTimeout).toBe('30s')
    expect(config.sourceOnDemandCloseAfter).toBe('60s')
  })
})

describe('loadVideoConfig', () => {
  const originalEnv = process.env

  function setEnv(overrides: Record<string, string>) {
    process.env = {
      ...originalEnv,
      CATALYST_ORCHESTRATOR_ENDPOINT: 'ws://localhost:3000',
      CATALYST_AUTH_ENDPOINT: 'http://localhost:3001',
      CATALYST_SYSTEM_TOKEN: 'test-token',
      ...overrides,
    }
  }

  afterEach(() => {
    process.env = originalEnv
  })

  it('loads defaults from env', () => {
    setEnv({})
    const config = loadVideoConfig()

    expect(config.enabled).toBe(false)
    expect(config.rtspPort).toBe(8554)
    expect(config.maxStreams).toBe(100)
  })

  it('reads CATALYST_VIDEO_ENABLED=true', () => {
    setEnv({ CATALYST_VIDEO_ENABLED: 'true' })
    const config = loadVideoConfig()
    expect(config.enabled).toBe(true)
  })

  it('reads custom ports from env', () => {
    setEnv({
      CATALYST_VIDEO_RTSP_PORT: '9554',
      CATALYST_VIDEO_RTMP_PORT: '2935',
    })
    const config = loadVideoConfig()

    expect(config.rtspPort).toBe(9554)
    expect(config.rtmpPort).toBe(2935)
  })

  it('reads CATALYST_VIDEO_ADVERTISE_ADDRESS', () => {
    setEnv({ CATALYST_VIDEO_ADVERTISE_ADDRESS: '10.0.1.5' })
    const config = loadVideoConfig()
    expect(config.advertiseAddress).toBe('10.0.1.5')
  })

  it('falls back to hostname from CATALYST_PEERING_ENDPOINT for advertiseAddress', () => {
    setEnv({ CATALYST_PEERING_ENDPOINT: 'ws://node-alpha.local:3000/ws' })
    const config = loadVideoConfig()
    expect(config.advertiseAddress).toBe('node-alpha.local')
  })

  it('prefers CATALYST_VIDEO_ADVERTISE_ADDRESS over peering endpoint fallback', () => {
    setEnv({
      CATALYST_VIDEO_ADVERTISE_ADDRESS: '10.0.1.5',
      CATALYST_PEERING_ENDPOINT: 'ws://node-alpha.local:3000/ws',
    })
    const config = loadVideoConfig()
    expect(config.advertiseAddress).toBe('10.0.1.5')
  })

  it('reads CATALYST_VIDEO_MAX_STREAMS', () => {
    setEnv({ CATALYST_VIDEO_MAX_STREAMS: '50' })
    const config = loadVideoConfig()
    expect(config.maxStreams).toBe(50)
  })

  it('reads CATALYST_VIDEO_AUTH_FAIL_PUBLISH=open', () => {
    setEnv({ CATALYST_VIDEO_AUTH_FAIL_PUBLISH: 'open' })
    const config = loadVideoConfig()
    expect(config.authFailPublish).toBe('open')
  })
})
