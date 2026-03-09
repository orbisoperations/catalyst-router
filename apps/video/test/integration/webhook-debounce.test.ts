import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createVideoHooks } from '../../src/video-control.js'
import type { StreamCatalog } from '../../src/bus-client.js'

/**
 * Integration tests for the video webhook debounce and dispatch behavior.
 *
 * These tests exercise createVideoHooks directly (mounted on a local Hono app)
 * to avoid capnweb's proxy-disposal issue with mocked dispatch capabilities.
 * This gives us a real vi.fn() dispatch that we can inspect for call counts
 * and arguments while still going through the full HTTP handler path.
 */

const DEBOUNCE_MS = 50

const sampleCatalog: StreamCatalog = {
  streams: [{ name: 'cam-front', protocol: 'media', source: 'local', sourceNode: 'test-node' }],
}

function createTestApp(
  opts: {
    isReady?: () => boolean
  } = {}
) {
  const dispatch = vi
    .fn<(action: unknown) => Promise<{ success: boolean }>>()
    .mockResolvedValue({ success: true })
  const isReady = opts.isReady ?? (() => true)

  const hooks = createVideoHooks({
    dispatch,
    getCatalog: () => sampleCatalog,
    nodeId: 'test-node',
    domains: ['test.local'],
    debounceMs: DEBOUNCE_MS,
    isReady,
  })

  const app = new Hono()
  app.route('/video-stream', hooks.handler)

  return { app, dispatch, hooks }
}

async function postWebhook(
  app: Hono,
  hook: 'ready' | 'not-ready',
  body: Record<string, unknown>
): Promise<Response> {
  const req = new Request(`http://localhost/video-stream/hooks/${hook}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return app.request(req)
}

// ---------------------------------------------------------------------------
// Test: single webhook fires dispatch after debounce
// ---------------------------------------------------------------------------

describe('Webhook debounce: single webhook fires dispatch after debounce', () => {
  it('dispatches exactly once after the debounce window', async () => {
    const { app, dispatch, hooks } = createTestApp()

    const res = await postWebhook(app, 'ready', {
      path: 'cam-1',
      sourceType: 'rtspSource',
    })
    expect(res.status).toBe(200)

    // Dispatch should NOT have been called yet (still in debounce window)
    expect(dispatch).not.toHaveBeenCalled()

    // Wait for debounce + margin
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50))

    // Dispatch should have been called exactly once
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      action: 'LocalRouteCreate',
      data: {
        name: 'cam-1',
        protocol: 'media',
      },
    })

    hooks.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test: rapid duplicate webhooks coalesce
// ---------------------------------------------------------------------------

describe('Webhook debounce: rapid duplicate webhooks coalesce', () => {
  it('dispatches only once for 5 rapid identical webhooks', async () => {
    const { app, dispatch, hooks } = createTestApp()

    // Fire 5 rapid POSTs for the same path
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        postWebhook(app, 'ready', {
          path: 'cam-burst',
          sourceType: 'rtspSource',
        })
      )
    )

    // All HTTP responses should be 200 (accepted)
    for (const res of responses) {
      expect(res.status).toBe(200)
    }

    // Not dispatched yet
    expect(dispatch).not.toHaveBeenCalled()

    // Wait for debounce + margin
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50))

    // Only ONE dispatch should have fired, not 5
    expect(dispatch).toHaveBeenCalledTimes(1)

    hooks.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test: ready then not-ready for same stream
// ---------------------------------------------------------------------------

describe('Webhook debounce: ready then not-ready coalesces to last action', () => {
  it('dispatches only the not-ready action when it follows ready immediately', async () => {
    const { app, dispatch, hooks } = createTestApp()

    // POST ready
    const readyRes = await postWebhook(app, 'ready', {
      path: 'cam-toggle',
      sourceType: 'rtspSource',
    })
    expect(readyRes.status).toBe(200)

    // Immediately POST not-ready for same path
    const notReadyRes = await postWebhook(app, 'not-ready', {
      path: 'cam-toggle',
      sourceType: 'rtspSource',
    })
    expect(notReadyRes.status).toBe(200)

    // Wait for debounce + margin
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50))

    // Exactly one dispatch should have fired -- the not-ready (LocalRouteDelete)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      action: 'LocalRouteDelete',
      data: {
        name: 'cam-toggle',
        protocol: 'media',
      },
    })

    hooks.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test: invalid payload returns 400
// ---------------------------------------------------------------------------

describe('Webhook debounce: invalid payload', () => {
  it('returns 400 for missing path field', async () => {
    const { app, dispatch, hooks } = createTestApp()

    const res = await postWebhook(app, 'ready', {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()

    // No dispatch should have been attempted
    expect(dispatch).not.toHaveBeenCalled()

    hooks.cleanup()
  })

  it('returns 400 for empty path string', async () => {
    const { app, dispatch, hooks } = createTestApp()

    const res = await postWebhook(app, 'ready', { path: '' })
    expect(res.status).toBe(400)

    expect(dispatch).not.toHaveBeenCalled()

    hooks.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test: webhook returns 503 when service not ready
// ---------------------------------------------------------------------------

describe('Webhook debounce: service not ready', () => {
  it('returns 503 when isReady returns false', async () => {
    const { app, dispatch, hooks } = createTestApp({
      isReady: () => false,
    })

    const res = await postWebhook(app, 'ready', {
      path: 'cam-1',
      sourceType: 'rtspSource',
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBeDefined()

    // No dispatch should have been attempted
    expect(dispatch).not.toHaveBeenCalled()

    hooks.cleanup()
  })

  it('returns 503 for not-ready hook as well when service not ready', async () => {
    const { app, dispatch, hooks } = createTestApp({
      isReady: () => false,
    })

    const res = await postWebhook(app, 'not-ready', {
      path: 'cam-1',
      sourceType: 'rtspSource',
    })
    expect(res.status).toBe(503)

    expect(dispatch).not.toHaveBeenCalled()

    hooks.cleanup()
  })
})
