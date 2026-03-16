import { describe, expect, it, vi } from 'vitest'
import {
  createAuthHook,
  type TokenValidator,
  type StreamAccessEvaluator,
} from '../src/hooks/auth.js'

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

function makeHook(opts?: { validator?: TokenValidator; evaluator?: StreamAccessEvaluator }) {
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

describe('Auth Hook — POST /video-stream/auth', () => {
  describe('publish action', () => {
    it('allows publish from 127.0.0.1', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1' })),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
    })

    it('allows publish from ::1 (IPv6 localhost)', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '::1' })),
      })
      expect(res.status).toBe(200)
    })

    it('allows publish from ::ffff:127.0.0.1 (IPv4-mapped IPv6)', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '::ffff:127.0.0.1' })),
      })
      expect(res.status).toBe(200)
    })

    it('allows publish regardless of token content', async () => {
      const { app, validator } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1', token: 'garbage' })),
      })
      expect(res.status).toBe(200)
      expect(validator.validate).not.toHaveBeenCalled()
    })

    it('denies publish from remote IP', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '192.168.1.50' })),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('permission_denied')
      expect(body.reason).toContain('Remote publish')
    })

    it('denies publish from any non-localhost IP', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '10.0.1.100' })),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('read action', () => {
    it('allows read with valid JWT and Cedar permit', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
    })

    it('passes decoded payload to Cedar evaluator', async () => {
      const evaluator = makeEvaluator()
      const { app } = makeHook({ evaluator })
      await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(evaluator.evaluate).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1' }), {
        nodeId: 'test-node',
        domainId: 'test-domain',
      })
    })

    it('denies read when JWT is invalid', async () => {
      const validator = makeValidator({
        validate: vi.fn().mockResolvedValue({ valid: false, error: 'JWT has expired' }),
      })
      const { app } = makeHook({ validator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
      expect(body.reason).toContain('expired')
    })

    it('denies read when Cedar denies STREAM_VIEW', async () => {
      const evaluator = makeEvaluator('deny')
      const { app } = makeHook({ evaluator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('permission_denied')
      expect(body.reason).toContain('Cedar')
    })

    it('denies read with no token', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ token: undefined })),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.reason).toContain('No token')
    })

    it('denies read with empty string token and no password', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ token: '', password: undefined })),
      })
      expect(res.status).toBe(401)
    })

    it('passes correct resource context to Cedar evaluator', async () => {
      const evaluator = makeEvaluator()
      const { app } = makeHook({ evaluator })
      await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(evaluator.evaluate).toHaveBeenCalledWith(expect.anything(), {
        nodeId: 'test-node',
        domainId: 'test-domain',
      })
    })
  })

  describe('relay auth via password field', () => {
    it('uses password field when token is absent (RTSP relay)', async () => {
      const validator = makeValidator()
      const { app } = makeHook({ validator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ token: undefined, password: 'relay-jwt-token' })),
      })
      expect(res.status).toBe(200)
      expect(validator.validate).toHaveBeenCalledWith('relay-jwt-token')
    })
  })

  describe('playback action', () => {
    it('treats playback same as read', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'playback' })),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('fail-closed behavior', () => {
    it('returns 503 when token validator throws', async () => {
      const validator = makeValidator({
        validate: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      const { app } = makeHook({ validator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest()),
      })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('system_error')
      expect(body.reason).toContain('unreachable')
    })

    it('fails closed for reads even when playback action', async () => {
      const validator = makeValidator({
        validate: vi.fn().mockRejectedValue(new Error('timeout')),
      })
      const { app } = makeHook({ validator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'playback' })),
      })
      expect(res.status).toBe(503)
    })

    it('localhost publish succeeds even when auth service is down', async () => {
      const validator = makeValidator({
        validate: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      })
      const { app } = makeHook({ validator })
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1' })),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('input validation', () => {
    it('rejects malformed JSON', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with shell metacharacters', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ path: 'cam;rm -rf /' })),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.reason).toContain('unsafe characters')
    })

    it('rejects missing required fields', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty body', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with backticks', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ path: '`whoami`' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with dollar sign', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ path: '$HOME' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with slashes', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ path: '../etc/passwd' })),
      })
      expect(res.status).toBe(400)
    })

    it('accepts request with extra fields (stripped by schema)', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ action: 'publish', ip: '127.0.0.1', extra: 'field' })),
      })
      expect(res.status).toBe(200)
    })

    it('rejects request with missing action field', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '127.0.0.1',
          path: 'cam-front',
          protocol: 'rtsp',
          id: 'conn-1',
        }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid protocol value', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authRequest({ protocol: 'websocket' })),
      })
      expect(res.status).toBe(400)
    })
  })
})
