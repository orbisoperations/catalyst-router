import { describe, it, expect } from 'vitest'
import { generateMediaMTXConfig } from '../src/media/config-writer.js'
import type { VideoConfig } from '@catalyst/config'

const defaultConfig: VideoConfig = {
  enabled: true,
  rtspPort: 8554,
  srtPort: 8890,
  hlsPort: 8888,
  webrtcPort: 8889,
  authFailPublish: 'closed',
  authFailSubscribe: 'closed',
}

describe('generateMediaMTXConfig', () => {
  it('generates valid YAML with default ports', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 3000)
    expect(yaml).toContain('rtspAddress: ":8554"')
    expect(yaml).toContain('srtAddress: ":8890"')
    expect(yaml).toContain('hlsAddress: ":8888"')
    expect(yaml).toContain('webrtcAddress: ":8889"')
  })

  it('configures runOnReady hook pointing to service port', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 4000)
    expect(yaml).toContain('http://localhost:4000/video-stream/hooks/ready')
  })

  it('configures runOnNotReady hook pointing to service port', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 4000)
    expect(yaml).toContain('http://localhost:4000/video-stream/hooks/not-ready')
  })

  it('delegates auth to HTTP hook (no publishIPs / authInternalUsers)', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 3000)
    expect(yaml).not.toContain('publishIPs')
    expect(yaml).not.toContain('authInternalUsers')
    expect(yaml).toContain('authHTTPAddress')
  })

  it('enables the API on port 9997', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 3000)
    expect(yaml).toContain('api: true')
    expect(yaml).toContain('apiAddress: ":9997"')
  })

  it('uses custom ports from config', () => {
    const config: VideoConfig = { ...defaultConfig, rtspPort: 9554, hlsPort: 9888 }
    const yaml = generateMediaMTXConfig(config, 3000)
    expect(yaml).toContain('rtspAddress: ":9554"')
    expect(yaml).toContain('hlsAddress: ":9888"')
  })

  it('configures auth endpoint when provided', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 3000)
    expect(yaml).toContain('http://localhost:3000/video-stream/auth')
  })

  it('includes authFail directives with default closed values', () => {
    const yaml = generateMediaMTXConfig(defaultConfig, 3000)
    expect(yaml).toContain('authFailOnPublish: closed')
    expect(yaml).toContain('authFailOnRead: closed')
  })

  it('includes authFail directives with open values', () => {
    const config: VideoConfig = {
      ...defaultConfig,
      authFailPublish: 'open',
      authFailSubscribe: 'open',
    }
    const yaml = generateMediaMTXConfig(config, 3000)
    expect(yaml).toContain('authFailOnPublish: open')
    expect(yaml).toContain('authFailOnRead: open')
  })
})
