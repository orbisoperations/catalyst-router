import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { resolveAuthUrl } from '../../src/clients/auth-client.js'

describe('resolveAuthUrl', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.CATALYST_AUTH_URL
    delete process.env.CATALYST_AUTH_URL
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CATALYST_AUTH_URL = originalEnv
    } else {
      delete process.env.CATALYST_AUTH_URL
    }
  })

  it('should return explicit URL when provided', () => {
    process.env.CATALYST_AUTH_URL = 'ws://from-env:4000/rpc'
    expect(resolveAuthUrl('ws://explicit:4000/rpc')).toBe('ws://explicit:4000/rpc')
  })

  it('should fall back to CATALYST_AUTH_URL env var', () => {
    process.env.CATALYST_AUTH_URL = 'ws://from-env:4000/rpc'
    expect(resolveAuthUrl()).toBe('ws://from-env:4000/rpc')
  })

  it('should fall back to default when no URL or env var', () => {
    expect(resolveAuthUrl()).toBe('ws://localhost:4000/rpc')
  })
})
