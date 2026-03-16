import { describe, it, expect, vi } from 'vitest'
import {
  createAuthHook,
  type TokenValidator,
  type StreamAccessEvaluator,
} from '../src/hooks/auth.js'

/**
 * Tests for relay authentication flow (T14).
 *
 * RTSP has no Bearer header, so relay connections tunnel the DATA_CUSTODIAN
 * JWT via MediaMTX's sourcePass field. The publishing node's auth hook
 * extracts the JWT from the `password` field for relay reads and evaluates
 * it through the same Cedar STREAM_VIEW flow as viewer reads.
 */

function makeValidator(overrides?: Partial<TokenValidator>): TokenValidator {
  return {
    validate: vi.fn().mockResolvedValue({ valid: true, payload: { sub: 'relay-node' } }),
    ...overrides,
  }
}

function makeEvaluator(decision: 'allow' | 'deny' = 'allow'): StreamAccessEvaluator {
  return {
    evaluate: vi.fn().mockReturnValue(decision),
  }
}

function makeApp(opts?: { validator?: TokenValidator; evaluator?: StreamAccessEvaluator }) {
  return createAuthHook({
    tokenValidator: opts?.validator ?? makeValidator(),
    streamAccess: opts?.evaluator ?? makeEvaluator(),
    nodeId: 'node-a',
    domainId: 'example.local',
  })
}

function relayReadRequest(jwt: string) {
  return {
    user: 'relay',
    password: jwt,
    ip: '10.0.1.6', // remote relay node IP
    action: 'read' as const,
    path: 'cam-1',
    protocol: 'rtsp' as const,
    id: 'relay-session-1',
  }
}

describe('Relay authentication via password field', () => {
  it('accepts relay read with valid DATA_CUSTODIAN JWT in password field', async () => {
    const validator = makeValidator()
    const evaluator = makeEvaluator('allow')
    const app = makeApp({ validator, evaluator })

    const req = relayReadRequest('valid-data-custodian-jwt')
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })

    expect(res.status).toBe(200)
    expect(validator.validate).toHaveBeenCalledWith('valid-data-custodian-jwt')
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      { sub: 'relay-node' },
      { nodeId: 'node-a', domainId: 'example.local' }
    )
  })

  it('rejects relay read with expired JWT in password field', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockResolvedValue({ valid: false, error: 'Token expired' }),
    })
    const app = makeApp({ validator })

    const req = relayReadRequest('expired-jwt')
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  it('rejects relay read when Cedar STREAM_VIEW denies access', async () => {
    const evaluator = makeEvaluator('deny')
    const app = makeApp({ evaluator })

    const req = relayReadRequest('valid-jwt-but-no-cedar-access')
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('permission_denied')
  })

  it('rejects relay read with no credentials at all', async () => {
    const app = makeApp()

    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: '10.0.1.6',
        action: 'read',
        path: 'cam-1',
        protocol: 'rtsp',
        id: 'relay-session-1',
        // no token, no password
      }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('No token provided')
  })

  it('prefers token field over password field when both present', async () => {
    const validator = makeValidator()
    const app = makeApp({ validator })

    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'viewer-jwt',
        password: 'relay-jwt',
        ip: '10.0.1.6',
        action: 'read',
        path: 'cam-1',
        protocol: 'rtsp',
        id: 'session-1',
      }),
    })

    expect(res.status).toBe(200)
    // token field takes precedence
    expect(validator.validate).toHaveBeenCalledWith('viewer-jwt')
  })

  it('returns 503 when auth service is unreachable during relay auth', async () => {
    const validator = makeValidator({
      validate: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    })
    const app = makeApp({ validator })

    const req = relayReadRequest('some-jwt')
    const res = await app.request('/video-stream/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('system_error')
  })
})
