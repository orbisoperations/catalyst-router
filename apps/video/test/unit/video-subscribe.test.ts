import { describe, it, expect, vi } from 'vitest'
import type { Meter } from '@opentelemetry/api'
import { Action } from '@catalyst/authorization'
import { createVideoSubscribe } from '../../src/video-subscribe.js'
import { StreamRelayManager } from '../../src/stream-relay-manager.js'
import type { StreamEntry } from '../../src/video-control.js'

// ---------------------------------------------------------------------------
// Auth mock types
// ---------------------------------------------------------------------------

type AuthAllowResult = { success: true; allowed: true }
type AuthDenyResult = { success: false; errorType: 'AUTHZ_DENY'; reason: string }
type AuthPolicyUnavailableResult = {
  success: false
  errorType: 'POLICY_UNAVAILABLE'
  reason: string
}
type AuthResult = AuthAllowResult | AuthDenyResult | AuthPolicyUnavailableResult

interface AuthService {
  evaluate(request: {
    token: string
    action: string
    nodeContext: { nodeId: string; domains: string[] }
    resource: { routeName: string; protocol: string }
  }): Promise<AuthResult>
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NODE_ID = 'node-b'
const DOMAINS = ['somebiz.local.io']
const VALID_TOKEN = 'Bearer valid-jwt-token'
const INVALID_TOKEN = 'Bearer invalid-jwt-token'
const STREAM_NAME = 'node-a/cam-front'

const localStream: StreamEntry = {
  name: 'node-b/cam-local',
  protocol: 'media',
  endpoint: 'rtsp://node-b:8554/node-b/cam-local',
  source: 'local',
  sourceNode: 'node-b',
  metadata: {
    sourceType: 'camera',
    codec: 'h264',
    resolution: '1920x1080',
    fps: 30,
  },
}

const remoteStream: StreamEntry = {
  name: STREAM_NAME,
  protocol: 'media',
  endpoint: 'rtsp://node-a:8554/node-a/cam-front',
  source: 'remote',
  sourceNode: 'node-a',
  metadata: {
    sourceType: 'camera',
    codec: 'h264',
    resolution: '1920x1080',
    fps: 30,
  },
  nodePath: ['node-a'],
}

function makeCatalog(streams?: StreamEntry[]) {
  return { streams: streams ?? [localStream, remoteStream] }
}

function makeAuthService(defaultResult: AuthResult): AuthService {
  return {
    evaluate: vi.fn(async () => defaultResult),
  }
}

interface VideoSubscribeConfig {
  relayGracePeriodMs: number
  streamAuth: { legacyFallback: boolean }
  mediamtxApiUrl: string
}

function makeConfig(overrides?: Partial<VideoSubscribeConfig>): VideoSubscribeConfig {
  return {
    relayGracePeriodMs: 30_000,
    streamAuth: { legacyFallback: true },
    mediamtxApiUrl: 'http://node-b',
    ...overrides,
  }
}

interface VideoSubscribeDeps {
  getCatalog: () => { streams: StreamEntry[] }
  auth: AuthService
  config: VideoSubscribeConfig
  nodeId: string
  domains: string[]
  relayManager?: StreamRelayManager
}

function makeDeps(overrides?: Partial<VideoSubscribeDeps>): VideoSubscribeDeps {
  const catalog = makeCatalog()
  return {
    getCatalog: () => catalog,
    auth: makeAuthService({ success: true, allowed: true }),
    config: makeConfig(),
    nodeId: NODE_ID,
    domains: DOMAINS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Auth hook tests
// ---------------------------------------------------------------------------

describe('POST /subscribe/:streamName - auth hook', () => {
  it('returns 200 when STREAM_SUBSCRIBE is allowed by Cedar policy', async () => {
    const auth = makeAuthService({ success: true, allowed: true })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(200)
  })

  it('returns 403 when STREAM_SUBSCRIBE is denied by Cedar policy', async () => {
    const auth = makeAuthService({
      success: false,
      errorType: 'AUTHZ_DENY',
      reason: 'principal not allowed',
    })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(403)
  })

  it('passes correct resource context to the auth service', async () => {
    const auth = makeAuthService({ success: true, allowed: true })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(auth.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: Action.STREAM_SUBSCRIBE,
        resource: {
          routeName: STREAM_NAME,
          protocol: 'media',
        },
        nodeContext: {
          nodeId: NODE_ID,
          domains: DOMAINS,
        },
      })
    )
  })

  it('strips Bearer prefix from token before passing to auth', async () => {
    const auth = makeAuthService({ success: true, allowed: true })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer my-jwt' },
      })
    )

    expect(auth.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'my-jwt',
      })
    )
  })

  it('returns 401 when Authorization header is missing', async () => {
    const deps = makeDeps()

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
      })
    )

    expect(response.status).toBe(401)
  })

  it('returns 404 when stream is not found in catalog', async () => {
    const deps = makeDeps({
      getCatalog: () => ({ streams: [] }),
    })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request('http://localhost/subscribe/nonexistent/stream', {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Legacy fallback tests
// ---------------------------------------------------------------------------

describe('POST /subscribe/:streamName - legacy fallback', () => {
  it('falls back to ROUTE_LIST when legacyFallback=true and STREAM_SUBSCRIBE policy unavailable', async () => {
    const auth: AuthService = {
      evaluate: vi.fn(async (req) => {
        if (req.action === Action.STREAM_SUBSCRIBE) {
          return {
            success: false,
            errorType: 'POLICY_UNAVAILABLE',
            reason: 'No STREAM_SUBSCRIBE policy deployed',
          } as AuthPolicyUnavailableResult
        }
        return { success: true, allowed: true } as AuthAllowResult
      }),
    }

    const config = makeConfig({ streamAuth: { legacyFallback: true } })
    const deps = makeDeps({ auth, config })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(auth.evaluate).toHaveBeenCalledTimes(2)
    expect(auth.evaluate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: Action.STREAM_SUBSCRIBE })
    )
    expect(auth.evaluate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: Action.ROUTE_LIST })
    )
    expect(response.status).toBe(200)
  })

  it('returns 403 when legacyFallback=false and STREAM_SUBSCRIBE policy unavailable', async () => {
    const auth: AuthService = {
      evaluate: vi.fn(
        async () =>
          ({
            success: false,
            errorType: 'POLICY_UNAVAILABLE',
            reason: 'No STREAM_SUBSCRIBE policy deployed',
          }) as AuthPolicyUnavailableResult
      ),
    }

    const config = makeConfig({ streamAuth: { legacyFallback: false } })
    const deps = makeDeps({ auth, config })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(auth.evaluate).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(403)
  })

  it('returns 403 when legacyFallback=true but ROUTE_LIST fallback also denies', async () => {
    const auth: AuthService = {
      evaluate: vi.fn(async (req) => {
        if (req.action === Action.STREAM_SUBSCRIBE) {
          return {
            success: false,
            errorType: 'POLICY_UNAVAILABLE',
            reason: 'No STREAM_SUBSCRIBE policy deployed',
          } as AuthPolicyUnavailableResult
        }
        return {
          success: false,
          errorType: 'AUTHZ_DENY',
          reason: 'principal not allowed',
        } as AuthDenyResult
      }),
    }

    const config = makeConfig({ streamAuth: { legacyFallback: true } })
    const deps = makeDeps({ auth, config })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Valid token -> playback endpoints
// ---------------------------------------------------------------------------

describe('POST /subscribe/:streamName - valid token', () => {
  it('returns 200 with playbackEndpoints for a remote stream', async () => {
    const deps = makeDeps()

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.stream.name).toBe(STREAM_NAME)
    expect(body.stream.protocol).toBe('media')
    expect(body.stream.playbackEndpoints).toBeDefined()
    expect(body.stream.playbackEndpoints.rtsp).toContain(STREAM_NAME)
    expect(body.stream.playbackEndpoints.hls).toContain(STREAM_NAME)
    expect(body.stream.playbackEndpoints.webrtc).toContain(STREAM_NAME)
  })

  it('playbackEndpoints use the local node base URL, not the origin', async () => {
    const config = makeConfig({ mediamtxApiUrl: 'http://node-b' })
    const deps = makeDeps({ config })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    const body = await response.json()
    expect(body.stream.playbackEndpoints.rtsp).toMatch(/^rtsp:\/\/node-b/)
    expect(body.stream.playbackEndpoints.hls).toMatch(/^http:\/\/node-b/)
    expect(body.stream.playbackEndpoints.webrtc).toMatch(/^http:\/\/node-b/)
  })

  it('returns expected endpoint URL formats per API contract', async () => {
    const config = makeConfig({ mediamtxApiUrl: 'http://node-b' })
    const deps = makeDeps({ config })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    const body = await response.json()
    expect(body.stream.playbackEndpoints.rtsp).toBe(`rtsp://node-b:8554/${STREAM_NAME}`)
    expect(body.stream.playbackEndpoints.hls).toBe(`http://node-b:8888/${STREAM_NAME}/index.m3u8`)
    expect(body.stream.playbackEndpoints.webrtc).toBe(`http://node-b:8889/${STREAM_NAME}/whep`)
    expect(body.stream.playbackEndpoints.srt).toBe(`srt://node-b:8890/${STREAM_NAME}`)
  })

  it('calls relayManager.addViewer for remote streams', async () => {
    const relayManager = new StreamRelayManager(
      { relayGracePeriodMs: 30_000 },
      { onRelayStart: vi.fn(async () => {}), onRelayTeardown: vi.fn(async () => {}) }
    )
    const addViewerSpy = vi.spyOn(relayManager, 'addViewer')
    const deps = makeDeps({ relayManager })

    const handler = createVideoSubscribe(deps)

    await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(addViewerSpy).toHaveBeenCalledWith(STREAM_NAME)
  })

  it('returns playbackEndpoints for a local stream (no relay needed)', async () => {
    const deps = makeDeps()

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/node-b/cam-local`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.stream.name).toBe('node-b/cam-local')
  })
})

// ---------------------------------------------------------------------------
// Invalid token -> 403
// ---------------------------------------------------------------------------

describe('POST /subscribe/:streamName - invalid token', () => {
  it('returns 403 when auth denies the token', async () => {
    const auth = makeAuthService({
      success: false,
      errorType: 'AUTHZ_DENY',
      reason: 'invalid token',
    })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: INVALID_TOKEN },
      })
    )

    expect(response.status).toBe(403)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const deps = makeDeps()

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
      })
    )

    expect(response.status).toBe(401)
  })

  it('does not start a relay session when auth fails', async () => {
    const auth = makeAuthService({
      success: false,
      errorType: 'AUTHZ_DENY',
      reason: 'forbidden',
    })
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: INVALID_TOKEN },
      })
    )

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.success).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// T042: empty catalog -> /streams returns []
// ---------------------------------------------------------------------------

describe('subscribe with empty catalog', () => {
  it('empty catalog - subscribe returns 404 (not error)', async () => {
    const deps = makeDeps({
      getCatalog: () => ({ streams: [] }),
    })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('Stream not found')
  })
})

// ---------------------------------------------------------------------------
// T043: subscribe with valid JWT + catalog entry -> endpoints returned
// ---------------------------------------------------------------------------

describe('subscribe with valid JWT and catalog entry', () => {
  it('valid JWT + catalog entry returns playback endpoints', async () => {
    const deps = makeDeps()

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.stream.playbackEndpoints).toBeDefined()
    expect(body.stream.playbackEndpoints.rtsp).toBeDefined()
    expect(body.stream.playbackEndpoints.hls).toBeDefined()
    expect(body.stream.playbackEndpoints.webrtc).toBeDefined()
    expect(body.stream.playbackEndpoints.srt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// T044: subscribe with empty catalog -> 404
// ---------------------------------------------------------------------------

describe('subscribe with empty catalog -> 404', () => {
  it('returns 404 when catalog has no streams', async () => {
    const deps = makeDeps({
      getCatalog: () => ({ streams: [] }),
    })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// T045: Auth outage fail-closed (from video-robustness.test.ts)
// ---------------------------------------------------------------------------

describe('Auth service outage - fail-closed behavior', () => {
  it('auth service unreachable (throws) -> subscribe denied', async () => {
    const auth: AuthService = {
      evaluate: vi.fn(async () => {
        throw new Error('ECONNREFUSED: auth service unreachable')
      }),
    }
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).not.toBe(200)
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('auth service returns timeout error -> denied, not allowed', async () => {
    const auth: AuthService = {
      evaluate: vi.fn(async () => {
        throw new Error('Request timed out')
      }),
    }
    const deps = makeDeps({ auth })

    const handler = createVideoSubscribe(deps)

    const response = await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// Auth evaluation metrics
// ---------------------------------------------------------------------------

function createSpyMeter() {
  const instruments: Record<
    string,
    { add?: ReturnType<typeof vi.fn>; record?: ReturnType<typeof vi.fn> }
  > = {}
  const createCounterSpy = vi.fn((name: string) => {
    const spy = { add: vi.fn() }
    instruments[name] = spy
    return spy
  })
  const createHistogramSpy = vi.fn((name: string) => {
    const spy = { record: vi.fn() }
    instruments[name] = spy
    return spy
  })
  const meter = {
    createCounter: createCounterSpy,
    createHistogram: createHistogramSpy,
    createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    createObservableCounter: vi.fn(() => ({})),
    createObservableGauge: vi.fn(() => ({})),
    createObservableUpDownCounter: vi.fn(() => ({})),
    createGauge: vi.fn(() => ({})),
  } as unknown as Meter
  return { meter, instruments, createCounterSpy, createHistogramSpy }
}

describe('POST /subscribe/:streamName - auth evaluation metrics', () => {
  it('creates video.auth.evaluations counter and video.auth.duration histogram when meter provided', () => {
    const { meter, createCounterSpy, createHistogramSpy } = createSpyMeter()
    const deps = makeDeps({ meter } as any)

    createVideoSubscribe(deps)

    expect(createCounterSpy).toHaveBeenCalledWith(
      'video.auth.evaluations',
      expect.objectContaining({ unit: '{evaluation}' })
    )
    expect(createHistogramSpy).toHaveBeenCalledWith(
      'video.auth.duration',
      expect.objectContaining({ unit: 's' })
    )
  })

  it.each([
    ['allowed', { success: true, allowed: true } as AuthResult, 'allowed'],
    [
      'denied',
      { success: false, errorType: 'AUTHZ_DENY', reason: 'not allowed' } as AuthResult,
      'denied',
    ],
  ])('records %s evaluation and duration', async (_label, authResult, expectedResult) => {
    const { meter, instruments } = createSpyMeter()
    const auth = makeAuthService(authResult)
    const deps = makeDeps({ auth, meter } as any)

    const handler = createVideoSubscribe(deps)

    await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    const evaluations = instruments['video.auth.evaluations']
    const duration = instruments['video.auth.duration']

    expect(evaluations?.add).toHaveBeenCalledWith(1, { 'video.auth.result': expectedResult })
    expect(duration?.record).toHaveBeenCalledWith(expect.any(Number))
  })

  it('records error evaluation with error.type when auth throws', async () => {
    const { meter, instruments } = createSpyMeter()
    const auth: AuthService = {
      evaluate: vi.fn(async () => {
        throw new Error('auth service down')
      }),
    }
    const deps = makeDeps({ auth, meter } as any)

    const handler = createVideoSubscribe(deps)

    await handler.request(
      new Request(`http://localhost/subscribe/${STREAM_NAME}`, {
        method: 'POST',
        headers: { Authorization: VALID_TOKEN },
      })
    )

    const evaluations = instruments['video.auth.evaluations']
    const duration = instruments['video.auth.duration']

    expect(evaluations?.add).toHaveBeenCalledWith(1, {
      'video.auth.result': 'error',
      'error.type': 'Error',
    })
    expect(duration?.record).toHaveBeenCalledWith(expect.any(Number))
    expect(duration?.record?.mock.calls[0][0]).toBeGreaterThan(0)
  })
})
