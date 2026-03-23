import { describe, expect, it } from 'vitest'
import {
  generateMediaMtxConfig,
  serializeMediaMtxConfig,
} from '../src/mediamtx/config-generator.js'
import { VideoConfigSchema } from '../src/config.js'

function makeConfig(overrides: Record<string, unknown> = {}) {
  return VideoConfigSchema.parse({
    orchestratorEndpoint: 'ws://localhost:3000',
    authEndpoint: 'http://localhost:3001',
    systemToken: 'test-token',
    ...overrides,
  })
}

describe('generateMediaMtxConfig', () => {
  const servicePort = 3002

  it('generates config with default values', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, servicePort)

    expect(mtx.rtspAddress).toBe(':8554')
    expect(mtx.rtmpAddress).toBe(':1935')
    expect(mtx.hlsAddress).toBe(':8888')
    expect(mtx.apiAddress).toBe('127.0.0.1:9997')
    expect(mtx.metricsAddress).toBe('127.0.0.1:9998')
  })

  it('maps custom ports to MediaMTX addresses', () => {
    const config = makeConfig({
      rtspPort: 9554,
      rtmpPort: 2935,
      hlsPort: 9888,
      apiPort: 9998,
      metricsPort: 9999,
    })
    const mtx = generateMediaMtxConfig(config, servicePort)

    expect(mtx.rtspAddress).toBe(':9554')
    expect(mtx.rtmpAddress).toBe(':2935')
    expect(mtx.hlsAddress).toBe(':9888')
    expect(mtx.apiAddress).toBe('127.0.0.1:9998')
    expect(mtx.metricsAddress).toBe('127.0.0.1:9999')
  })

  it('disables SRT — streamid too short for JWT', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.srt).toBe(false)
  })

  it('disables WebRTC — STUN/TURN/pprof security issues', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.webrtc).toBe(false)
  })

  it('disables pprof — heap dump credential leak', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.pprof).toBe(false)
  })

  it('disables recording — path traversal risk', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.record).toBe(false)
  })

  it('binds API to localhost only — prevents unauthorized access', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.apiAddress).toMatch(/^127\.0\.0\.1:/)
  })

  it('configures auth hook pointing to VideoStreamService', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)

    expect(mtx.authMethod).toBe('http')
    expect(mtx.authHTTPAddress).toBe(`http://127.0.0.1:${servicePort}/video-stream/auth`)
  })

  it('excludes api and metrics from external auth', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)

    expect(mtx.authHTTPExclude).toEqual([{ action: 'api' }, { action: 'metrics' }])
  })

  it('sets lifecycle hooks with curl commands', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)

    expect(mtx.pathDefaults.runOnReady).toContain(`${servicePort}/video-stream/hooks/ready`)
    expect(mtx.pathDefaults.runOnNotReady).toContain(`${servicePort}/video-stream/hooks/not-ready`)
    expect(mtx.pathDefaults.runOnReadyRestart).toBe('yes')
  })

  it('passes sourceOnDemand timeouts through', () => {
    const config = makeConfig({
      sourceOnDemandStartTimeout: '15s',
      sourceOnDemandCloseAfter: '30s',
    })
    const mtx = generateMediaMtxConfig(config, servicePort)

    expect(mtx.pathDefaults.sourceOnDemandStartTimeout).toBe('15s')
    expect(mtx.pathDefaults.sourceOnDemandCloseAfter).toBe('30s')
  })

  it('enables overridePublisher for camera reconnection', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.pathDefaults.overridePublisher).toBe(true)
  })
})

describe('serializeMediaMtxConfig', () => {
  it('produces valid YAML with all security settings commented', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, 3002)
    const yaml = serializeMediaMtxConfig(mtx)

    // Security settings present in output
    expect(yaml).toContain('srt: false')
    expect(yaml).toContain('webrtc: false')
    expect(yaml).toContain('pprof: false')
    expect(yaml).toContain('record: false')

    // Security comments present
    expect(yaml).toContain('SRT disabled')
    expect(yaml).toContain('WebRTC disabled')
    expect(yaml).toContain('pprof disabled')
    expect(yaml).toContain('Recording disabled')
    expect(yaml).toContain('localhost-only')
  })

  it('contains all protocol listener addresses', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, 3002)
    const yaml = serializeMediaMtxConfig(mtx)

    expect(yaml).toContain('rtspAddress: ":8554"')
    expect(yaml).toContain('rtmpAddress: ":1935"')
    expect(yaml).toContain('hlsAddress: ":8888"')
  })

  it('contains auth hook configuration', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, 3002)
    const yaml = serializeMediaMtxConfig(mtx)

    expect(yaml).toContain('authMethod: http')
    expect(yaml).toContain('authHTTPAddress:')
    expect(yaml).toContain('authHTTPExclude:')
  })

  it('contains path defaults with lifecycle hooks', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, 3002)
    const yaml = serializeMediaMtxConfig(mtx)

    expect(yaml).toContain('pathDefaults:')
    expect(yaml).toContain('runOnReady:')
    expect(yaml).toContain('runOnReadyRestart: yes')
    expect(yaml).toContain('runOnNotReady:')
    expect(yaml).toContain('overridePublisher: true')
  })

  it('contains default paths section', () => {
    const config = makeConfig()
    const mtx = generateMediaMtxConfig(config, 3002)
    const yaml = serializeMediaMtxConfig(mtx)

    expect(yaml).toContain('paths:')
    expect(yaml).toContain('all_others:')
  })
})

describe('generateMediaMtxConfig — additional coverage', () => {
  const servicePort = 3002

  it('enables metrics', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.metrics).toBe(true)
  })

  it('hook URLs use 127.0.0.1 not localhost', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.pathDefaults.runOnReady).toContain('127.0.0.1')
    expect(mtx.pathDefaults.runOnReady).not.toContain('localhost')
    expect(mtx.pathDefaults.runOnNotReady).toContain('127.0.0.1')
    expect(mtx.pathDefaults.runOnNotReady).not.toContain('localhost')
  })

  it('auth hook URL uses 127.0.0.1 not localhost', () => {
    const mtx = generateMediaMtxConfig(makeConfig(), servicePort)
    expect(mtx.authHTTPAddress).toContain('127.0.0.1')
    expect(mtx.authHTTPAddress).not.toContain('localhost')
  })

  it('includes sourceOnDemand settings in path defaults', () => {
    const config = makeConfig({
      sourceOnDemandStartTimeout: '20s',
      sourceOnDemandCloseAfter: '30s',
    })
    const mtx = generateMediaMtxConfig(config, servicePort)
    expect(mtx.pathDefaults.sourceOnDemandStartTimeout).toBe('20s')
    expect(mtx.pathDefaults.sourceOnDemandCloseAfter).toBe('30s')
  })
})
