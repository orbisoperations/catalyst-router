import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { VideoConfigSchema, OrchestratorConfigSchema, loadDefaultConfig } from '../src/index.js'

describe('VideoConfigSchema', () => {
  it('should parse with all defaults', () => {
    const result = VideoConfigSchema.parse({})
    expect(result.port).toBe(4001)
    expect(result.mediamtxApiUrl).toBe('http://localhost:9997')
    expect(result.relayGracePeriodMs).toBe(30_000)
    expect(result.debounceDurationMs).toBe(500)
    expect(result.streamAuth.legacyFallback).toBe(true)
  })

  it('should parse with custom values', () => {
    const result = VideoConfigSchema.parse({
      port: 5000,
      authEndpoint: 'ws://auth:3000/api',
      nodeToken: 'test-token',
      mediamtxApiUrl: 'http://mediamtx:9997',
      relayGracePeriodMs: 60_000,
      debounceDurationMs: 1000,
      streamAuth: { legacyFallback: false },
    })
    expect(result.port).toBe(5000)
    expect(result.authEndpoint).toBe('ws://auth:3000/api')
    expect(result.nodeToken).toBe('test-token')
    expect(result.mediamtxApiUrl).toBe('http://mediamtx:9997')
    expect(result.relayGracePeriodMs).toBe(60_000)
    expect(result.debounceDurationMs).toBe(1000)
    expect(result.streamAuth.legacyFallback).toBe(false)
  })

  it('should accept optional authEndpoint and nodeToken', () => {
    const result = VideoConfigSchema.parse({})
    expect(result.authEndpoint).toBeUndefined()
    expect(result.nodeToken).toBeUndefined()
  })
})

describe('OrchestratorConfigSchema — video section', () => {
  it('video.enabled defaults to false', () => {
    const result = OrchestratorConfigSchema.safeParse({ video: {} })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video?.enabled).toBe(false)
    }
  })

  it('video.mediamtxApiUrl is an optional string', () => {
    const result = OrchestratorConfigSchema.safeParse({
      video: { mediamtxApiUrl: 'http://localhost:9997' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video?.mediamtxApiUrl).toBe('http://localhost:9997')
    }
  })

  it('video.relayGracePeriodMs defaults to 30000', () => {
    const result = OrchestratorConfigSchema.safeParse({ video: {} })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video?.relayGracePeriodMs).toBe(30000)
    }
  })

  it('video.streamAuth.legacyFallback defaults to false', () => {
    const result = OrchestratorConfigSchema.safeParse({ video: {} })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video?.streamAuth?.legacyFallback).toBe(false)
    }
  })

  it('entire video section is optional (missing = no video support)', () => {
    const result = OrchestratorConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video).toBeUndefined()
    }
  })

  it('rejects invalid types (relayGracePeriodMs as string)', () => {
    const result = OrchestratorConfigSchema.safeParse({
      video: { relayGracePeriodMs: 'not-a-number' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts video section with all fields explicitly set', () => {
    const result = OrchestratorConfigSchema.safeParse({
      video: {
        enabled: true,
        mediamtxApiUrl: 'http://mediamtx:9997',
        relayGracePeriodMs: 60000,
        streamAuth: {
          legacyFallback: false,
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.video?.enabled).toBe(true)
      expect(result.data.video?.mediamtxApiUrl).toBe('http://mediamtx:9997')
      expect(result.data.video?.relayGracePeriodMs).toBe(60000)
      expect(result.data.video?.streamAuth?.legacyFallback).toBe(false)
    }
  })

  it('accepts videoEndpoint as optional string', () => {
    const result = OrchestratorConfigSchema.safeParse({
      videoEndpoint: 'ws://video-a:4001/api',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.videoEndpoint).toBe('ws://video-a:4001/api')
    }
  })
})

describe('loadDefaultConfig for video', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.CATALYST_NODE_ID = 'test-node'
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should load video config from env vars', () => {
    process.env.CATALYST_VIDEO_PORT = '5000'
    process.env.CATALYST_VIDEO_AUTH_ENDPOINT = 'ws://auth:3000/api'
    process.env.CATALYST_VIDEO_NODE_TOKEN = 'my-token'
    process.env.CATALYST_VIDEO_MEDIAMTX_API_URL = 'http://mediamtx:9997'
    process.env.CATALYST_VIDEO_RELAY_GRACE_PERIOD_MS = '60000'
    process.env.CATALYST_VIDEO_DEBOUNCE_MS = '1000'
    process.env.CATALYST_VIDEO_STREAM_AUTH_LEGACY_FALLBACK = 'false'

    const config = loadDefaultConfig({ serviceType: 'video' })
    expect(config.video).toBeDefined()
    expect(config.video!.port).toBe(5000)
    expect(config.video!.authEndpoint).toBe('ws://auth:3000/api')
    expect(config.video!.nodeToken).toBe('my-token')
    expect(config.video!.mediamtxApiUrl).toBe('http://mediamtx:9997')
    expect(config.video!.relayGracePeriodMs).toBe(60_000)
    expect(config.video!.debounceDurationMs).toBe(1000)
    expect(config.video!.streamAuth.legacyFallback).toBe(false)
  })

  it('should use defaults when env vars are not set', () => {
    const config = loadDefaultConfig({ serviceType: 'video' })
    expect(config.video).toBeDefined()
    expect(config.video!.port).toBe(4001)
    expect(config.video!.mediamtxApiUrl).toBe('http://localhost:9997')
    expect(config.video!.relayGracePeriodMs).toBe(30_000)
    expect(config.video!.debounceDurationMs).toBe(500)
    expect(config.video!.streamAuth.legacyFallback).toBe(true)
  })

  it('should not require CATALYST_PEERING_ENDPOINT for video', () => {
    expect(() => loadDefaultConfig({ serviceType: 'video' })).not.toThrow()
  })

  it('should load orchestrator videoEndpoint from env', () => {
    process.env.CATALYST_PEERING_ENDPOINT = 'ws://localhost:3000/rpc'
    process.env.CATALYST_VIDEO_ENDPOINT = 'ws://video-a:4001/api'

    const config = loadDefaultConfig({ serviceType: 'orchestrator' })
    expect(config.orchestrator?.videoEndpoint).toBe('ws://video-a:4001/api')
  })
})
