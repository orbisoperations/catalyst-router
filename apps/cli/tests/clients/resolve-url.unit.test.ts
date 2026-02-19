import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { resolveServiceUrl } from '../../src/clients/resolve-url.js'

describe('resolveServiceUrl', () => {
  const TEST_ENV_VAR = 'CATALYST_TEST_SERVICE_URL'
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[TEST_ENV_VAR]
    delete process.env[TEST_ENV_VAR]
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env[TEST_ENV_VAR] = originalEnv
    } else {
      delete process.env[TEST_ENV_VAR]
    }
  })

  it('should return explicit URL when provided', () => {
    process.env[TEST_ENV_VAR] = 'ws://from-env:5000/rpc'
    const result = resolveServiceUrl({
      url: 'ws://explicit:5000/rpc',
      envVar: TEST_ENV_VAR,
      defaultPort: 5000,
    })
    expect(result).toBe('ws://explicit:5000/rpc')
  })

  it('should fall back to env var when no explicit URL', () => {
    process.env[TEST_ENV_VAR] = 'ws://from-env:5000/rpc'
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 5000,
    })
    expect(result).toBe('ws://from-env:5000/rpc')
  })

  it('should construct default URL when no explicit URL or env var', () => {
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 4000,
    })
    expect(result).toBe('ws://localhost:4000/rpc')
  })

  it('should use custom defaultPath', () => {
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 8080,
      defaultPath: '/api',
    })
    expect(result).toBe('ws://localhost:8080/api')
  })

  it('should use custom defaultProtocol in fallback URL', () => {
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
      defaultProtocol: 'http',
    })
    expect(result).toBe('http://localhost:3000/rpc')
  })

  it('should prepend default protocol when URL has no protocol', () => {
    const result = resolveServiceUrl({
      url: 'node.local:8000/rpc',
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
    })
    expect(result).toBe('ws://node.local:8000/rpc')
  })

  it('should prepend custom protocol when URL has no protocol', () => {
    const result = resolveServiceUrl({
      url: 'node.local:8000/api',
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
      defaultProtocol: 'http',
    })
    expect(result).toBe('http://node.local:8000/api')
  })

  it('should preserve existing protocol on explicit URL', () => {
    const result = resolveServiceUrl({
      url: 'http://custom:9000/graphql',
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
    })
    expect(result).toBe('http://custom:9000/graphql')
  })

  it('should preserve existing protocol on env var URL', () => {
    process.env[TEST_ENV_VAR] = 'wss://secure:5000/rpc'
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
    })
    expect(result).toBe('wss://secure:5000/rpc')
  })

  it('should prepend protocol to env var URL missing protocol', () => {
    process.env[TEST_ENV_VAR] = 'remote-host:4000/rpc'
    const result = resolveServiceUrl({
      envVar: TEST_ENV_VAR,
      defaultPort: 3000,
    })
    expect(result).toBe('ws://remote-host:4000/rpc')
  })

  describe('auth service defaults', () => {
    it('should match expected auth defaults', () => {
      const result = resolveServiceUrl({
        envVar: 'CATALYST_AUTH_URL',
        defaultPort: 4000,
      })
      expect(result).toBe('ws://localhost:4000/rpc')
    })
  })

  describe('orchestrator service defaults', () => {
    it('should match expected orchestrator defaults', () => {
      const result = resolveServiceUrl({
        envVar: 'CATALYST_ORCHESTRATOR_URL',
        defaultPort: 3000,
      })
      expect(result).toBe('ws://localhost:3000/rpc')
    })
  })
})
