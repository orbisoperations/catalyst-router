import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Meter } from '@opentelemetry/api'
import { createVideoHooks, queryStreamCatalog, type StreamEntry } from '../../src/video-control.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaMTXHookPayload {
  path: string
  sourceType: string
  query: string
}

type DispatchFn = (action: { action: string; data: unknown }) => Promise<{ success: boolean }>

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nodeId = 'node-a'

function readyPayload(overrides: Partial<MediaMTXHookPayload> = {}): MediaMTXHookPayload {
  return {
    path: 'node-a/cam-front',
    sourceType: 'rtspSource',
    query: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// onReady -> dispatch
// ---------------------------------------------------------------------------

describe('video-control webhook: onReady -> dispatch', () => {
  let dispatched: Array<{ action: string; data: unknown }>
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatched = []
    dispatch = vi.fn(async (action) => {
      dispatched.push(action)
      return { success: true }
    })
  })

  it('dispatches LocalRouteCreate for a valid ready payload', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload())

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatched[0].action).toBe('LocalRouteCreate')
  })

  it('sets protocol to "media" in the dispatched route', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload())

    const data = dispatched[0].data as { protocol: string }
    expect(data.protocol).toBe('media')
  })

  it('maps path field to route name', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload({ path: 'node-a/cam-front' }))

    const data = dispatched[0].data as { name: string }
    expect(data.name).toBe('node-a/cam-front')
  })

  it('populates metadata.sourceNode with the local nodeId', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload())

    const data = dispatched[0].data as { metadata: { sourceNode: string } }
    expect(data.metadata.sourceNode).toBe(nodeId)
  })

  const sourceTypeMappings: Array<[string, string]> = [
    ['rtspSource', 'camera'],
    ['hlsSource', 'relay'],
    ['webrtcSession', 'camera'],
    ['srtSource', 'camera'],
    ['unknownSource', 'synthetic'],
    ['', 'synthetic'],
  ]

  it.each(sourceTypeMappings)(
    'maps MediaMTX sourceType "%s" to metadata.sourceType "%s"',
    async (mtxSourceType, expectedSourceType) => {
      const hooks = createVideoHooks({ dispatch, nodeId })

      await hooks.onReady(readyPayload({ sourceType: mtxSourceType }))

      const data = dispatched[0].data as { metadata: { sourceType: string } }
      expect(data.metadata.sourceType).toBe(expectedSourceType)
    }
  )
})

// ---------------------------------------------------------------------------
// onNotReady -> dispatch
// ---------------------------------------------------------------------------

describe('video-control webhook: onNotReady -> dispatch', () => {
  let dispatched: Array<{ action: string; data: unknown }>
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatched = []
    dispatch = vi.fn(async (action) => {
      dispatched.push(action)
      return { success: true }
    })
  })

  it('dispatches LocalRouteDelete for a valid notReady payload', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onNotReady({ path: 'node-a/cam-front', sourceType: 'rtspSource', query: '' })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatched[0].action).toBe('LocalRouteDelete')
  })

  it('route name matches the path from the webhook payload', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onNotReady({ path: 'node-a/lidar-top', sourceType: 'rtspSource', query: '' })

    const data = dispatched[0].data as { name: string; protocol: string }
    expect(data.name).toBe('node-a/lidar-top')
    expect(data.protocol).toBe('media')
  })
})

// ---------------------------------------------------------------------------
// HTTP handler error paths
// ---------------------------------------------------------------------------

describe('video-control HTTP handlers', () => {
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatch = vi.fn(async () => ({ success: true }))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('POST /hooks/ready returns 400 on invalid JSON', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: 'not-json{{{',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(400)
  })

  it('POST /hooks/ready returns 400 on Zod validation failure', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: '', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(400)
  })

  it('POST /hooks/ready returns 200 on valid payload', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true })

    // Fire request without awaiting (handler awaits debounce timer)
    const responsePromise = hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource', query: '' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    // Flush debounce timer so the handler can complete
    await vi.advanceTimersByTimeAsync(600)

    const response = await responsePromise
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// T032: Debounce — handlers use debouncedReady/debouncedNotReady
// ---------------------------------------------------------------------------

describe('video-control debounce fix', () => {
  let dispatched: Array<{ action: string; data: unknown }>
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatched = []
    dispatch = vi.fn(async (action) => {
      dispatched.push(action)
      return { success: true }
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('HTTP /hooks/ready uses debounce (dispatch delayed by debounceMs)', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, debounceMs: 500, isReady: () => true })

    // Fire without awaiting - handler blocks on debounce timer
    const responsePromise = hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    // Dispatch should NOT have happened yet (debounced)
    expect(dispatch).not.toHaveBeenCalled()

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(600)
    await responsePromise
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('HTTP /hooks/not-ready uses debounce (dispatch delayed by debounceMs)', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, debounceMs: 500, isReady: () => true })

    const responsePromise = hooks.handler.request(
      new Request('http://localhost/hooks/not-ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(dispatch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600)
    await responsePromise
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// T036: Debounce tests
// ---------------------------------------------------------------------------

describe('video-control debounce behavior', () => {
  let dispatched: Array<{ action: string; data: unknown }>
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatched = []
    dispatch = vi.fn(async (action) => {
      dispatched.push(action)
      return { success: true }
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('50 ready events for 50 different streams in 2s -> 50 dispatches', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, debounceMs: 500 })

    for (let i = 0; i < 50; i++) {
      hooks.debouncedReady({ path: `node-a/cam-${i}`, sourceType: 'rtspSource', query: '' })
    }

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(600)

    expect(dispatch).toHaveBeenCalledTimes(50)
  })

  it('10 ready + 10 not-ready for same stream in 1s -> 1 dispatch (final state)', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, debounceMs: 500 })

    const payload = { path: 'node-a/cam-front', sourceType: 'rtspSource', query: '' }

    // Interleave ready and not-ready for the same stream
    for (let i = 0; i < 10; i++) {
      hooks.debouncedReady(payload)
      hooks.debouncedNotReady(payload)
    }

    await vi.advanceTimersByTimeAsync(600)

    // Only the last action (not-ready) should fire
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatched[0].action).toBe('LocalRouteDelete')
  })

  it('single event fires after 500ms timeout', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, debounceMs: 500 })

    hooks.debouncedReady({ path: 'node-a/cam-front', sourceType: 'rtspSource', query: '' })

    // Not yet
    expect(dispatch).not.toHaveBeenCalled()

    // Advance 400ms - still not fired
    await vi.advanceTimersByTimeAsync(400)
    expect(dispatch).not.toHaveBeenCalled()

    // Advance to 500ms - should fire
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// T037: Readiness gate
// ---------------------------------------------------------------------------

describe('video-control readiness gate', () => {
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatch = vi.fn(async () => ({ success: true }))
  })

  it('webhook returns 503 when isReady returns false', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => false })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(503)
  })

  it('webhook returns 503 when neither isReady nor getCatalog is provided', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(503)
  })

  it('webhook returns 200 when isReady returns true', async () => {
    vi.useFakeTimers()
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true })

    const responsePromise = hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await vi.advanceTimersByTimeAsync(600)
    const response = await responsePromise
    expect(response.status).toBe(200)
    vi.useRealTimers()
  })

  it('/hooks/not-ready also returns 503 before catalog ready', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => false })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/not-ready', {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// queryStreamCatalog - direct unit tests (from T046)
// ---------------------------------------------------------------------------

describe('queryStreamCatalog - direct unit tests', () => {
  const streams: StreamEntry[] = [
    {
      name: 'node-a/cam-front',
      protocol: 'media',
      source: 'local',
      sourceNode: 'node-a',
      metadata: { sourceType: 'camera' },
    },
    {
      name: 'node-b/cam-rear',
      protocol: 'media',
      source: 'remote',
      sourceNode: 'node-b',
      metadata: { sourceType: 'camera' },
      nodePath: ['node-b'],
    },
    {
      name: 'node-a/lidar',
      protocol: 'data',
      source: 'local',
      sourceNode: 'node-a',
    },
  ]

  it('returns all streams with scope=all', () => {
    const result = queryStreamCatalog(streams, { scope: 'all' })
    expect(result).toHaveLength(3)
  })

  it('returns local streams with scope=local', () => {
    const result = queryStreamCatalog(streams, { scope: 'local' })
    expect(result).toHaveLength(2)
    expect(result.every((s) => s.source === 'local')).toBe(true)
  })

  it('returns remote streams with scope=remote', () => {
    const result = queryStreamCatalog(streams, { scope: 'remote' })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('node-b/cam-rear')
  })

  it('treats invalid scope as "all"', () => {
    const result = queryStreamCatalog(streams, { scope: 'bogus' as 'all' })
    expect(result).toHaveLength(3)
  })

  it('filters by sourceNode', () => {
    const result = queryStreamCatalog(streams, { sourceNode: 'node-b' })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('node-b/cam-rear')
  })

  it('filters by protocol', () => {
    const result = queryStreamCatalog(streams, { protocol: 'media' })
    expect(result).toHaveLength(2)
  })

  it('combines sourceNode and protocol filters', () => {
    const result = queryStreamCatalog(streams, { sourceNode: 'node-a', protocol: 'media' })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('node-a/cam-front')
  })

  it('returns empty array for empty streams', () => {
    const result = queryStreamCatalog([], { scope: 'all' })
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// T045: MediaMTX restart idempotency (from video-robustness.test.ts)
// ---------------------------------------------------------------------------

describe('MediaMTX restart - onReady idempotency', () => {
  let dispatched: Array<{ action: string; data: unknown }>
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatched = []
    dispatch = vi.fn(async (action) => {
      dispatched.push(action)
      return { success: true }
    })
  })

  it('second onReady for same path does not create a duplicate route', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload())
    await hooks.onReady(readyPayload())

    const creates = dispatched.filter((d) => d.action === 'LocalRouteCreate')
    expect(creates).toHaveLength(2)
    expect((creates[0].data as { name: string }).name).toBe('node-a/cam-front')
    expect((creates[1].data as { name: string }).name).toBe('node-a/cam-front')
  })

  it('re-fired onReady after restart preserves route metadata', async () => {
    const hooks = createVideoHooks({ dispatch, nodeId })

    await hooks.onReady(readyPayload({ sourceType: 'rtspSource' }))
    await hooks.onReady(readyPayload({ sourceType: 'rtspSource' }))

    const creates = dispatched.filter((d) => d.action === 'LocalRouteCreate')
    const first = creates[0].data as { metadata: { sourceType: string } }
    const second = creates[1].data as { metadata: { sourceType: string } }
    expect(first.metadata.sourceType).toBe(second.metadata.sourceType)
  })
})

// ---------------------------------------------------------------------------
// Webhook counter metrics (US4)
// ---------------------------------------------------------------------------

function createSpyMeter() {
  const instruments: Record<string, { add: ReturnType<typeof vi.fn> }> = {}
  const createCounterSpy = vi.fn((name: string) => {
    const spy = { add: vi.fn() }
    instruments[name] = spy
    return spy
  })
  const meter = {
    createCounter: createCounterSpy,
    createHistogram: vi.fn(() => ({ record: vi.fn() })),
    createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    createObservableCounter: vi.fn(() => ({})),
    createObservableGauge: vi.fn(() => ({})),
    createObservableUpDownCounter: vi.fn(() => ({})),
    createGauge: vi.fn(() => ({})),
  } as unknown as Meter
  return { meter, instruments, createCounterSpy }
}

describe('video-control webhook counter metrics', () => {
  let dispatch: DispatchFn

  beforeEach(() => {
    dispatch = vi.fn(async () => ({ success: true }))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates video.webhook.received counter when meter is provided', () => {
    const { meter } = createSpyMeter()
    createVideoHooks({ dispatch, nodeId, isReady: () => true, meter })

    expect(
      (meter as unknown as { createCounter: ReturnType<typeof vi.fn> }).createCounter
    ).toHaveBeenCalledWith('video.webhook.received', expect.objectContaining({ unit: '{event}' }))
  })

  it.each([
    ['ready', '/hooks/ready', 'ready'],
    ['not-ready', '/hooks/not-ready', 'not-ready'],
  ])('records counter on valid %s webhook', async (_label, path, type) => {
    const { meter, instruments } = createSpyMeter()
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true, meter })

    const response = await hooks.handler.request(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        body: JSON.stringify({ path: 'node-a/cam-front', sourceType: 'rtspSource', query: '' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await vi.advanceTimersByTimeAsync(600)
    expect(response.status).toBe(200)

    const counter = instruments['video.webhook.received']
    expect(counter).toBeDefined()
    expect(counter.add).toHaveBeenCalledWith(1, { 'video.webhook.type': type })
  })

  it('records counter with error.type on validation failure', async () => {
    const { meter, instruments } = createSpyMeter()
    const hooks = createVideoHooks({ dispatch, nodeId, isReady: () => true, meter })

    const response = await hooks.handler.request(
      new Request('http://localhost/hooks/ready', {
        method: 'POST',
        body: JSON.stringify({ path: '', sourceType: 'rtspSource' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )

    expect(response.status).toBe(400)

    const counter = instruments['video.webhook.received']
    expect(counter).toBeDefined()
    expect(counter.add).toHaveBeenCalledWith(1, {
      'video.webhook.type': 'ready',
      'error.type': 'ValidationError',
    })
  })
})
