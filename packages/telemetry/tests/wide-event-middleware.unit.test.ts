/**
 * Wide-event Hono middleware unit tests.
 *
 * Uses a real Hono app with a spy LogTape configuration to inspect emitted
 * wide-event log records, rather than mocking module internals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { configure, reset } from '@logtape/logtape'
import type { LogRecord, Sink } from '@logtape/logtape'
import { wideEventMiddleware } from '../src/middleware/wide-event.js'
import { WideEvent } from '../src/wide-event.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured log records from the spy sink */
let captured: LogRecord[] = []

const spySink: Sink = (record: LogRecord) => {
  captured.push(record)
}

async function setupLogtape() {
  await configure({
    sinks: { spy: spySink },
    loggers: [{ category: ['catalyst', 'wide'], lowestLevel: 'debug', sinks: ['spy'] }],
  })
}

async function teardownLogtape() {
  await reset()
}

/** Build a minimal Hono app with the wide-event middleware and a configurable handler */
function buildApp(handler?: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.use('*', wideEventMiddleware())

  app.get('/ok', (c) => {
    if (handler) return handler(c)
    return c.text('OK')
  })

  app.get('/not-found', (c) => c.text('Not Found', 404))
  app.get('/server-error', (c) => c.text('Internal Server Error', 500))
  app.post('/submit', (c) => c.text('Created', 201))

  app.get('/boom', () => {
    throw new Error('kaboom')
  })

  return app
}

async function request(app: Hono, path: string, method: string = 'GET'): Promise<Response> {
  return app.request(path, { method })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wideEventMiddleware', () => {
  beforeEach(async () => {
    captured = []
    await setupLogtape()
  })

  afterEach(async () => {
    await teardownLogtape()
  })

  // -------------------------------------------------------------------------
  // Successful responses
  // -------------------------------------------------------------------------

  it('emits a wide event with HTTP method and status on success', async () => {
    const app = buildApp()
    const res = await request(app, '/ok')

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)

    const record = captured[0]
    expect(record.properties).toMatchObject({
      'event.name': 'http.request',
      'http.request.method': 'GET',
      'url.path': '/ok',
      'http.response.status_code': 200,
      'event.outcome': 'success',
    })
    expect(record.properties['event.duration_ms']).toBeTypeOf('number')
    expect(record.properties['event.duration_ms'] as number).toBeGreaterThanOrEqual(0)
  })

  it('captures POST method correctly', async () => {
    const app = buildApp()
    const res = await request(app, '/submit', 'POST')

    expect(res.status).toBe(201)
    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'http.request.method': 'POST',
      'http.response.status_code': 201,
      'event.outcome': 'success',
    })
  })

  // -------------------------------------------------------------------------
  // Error status codes
  // -------------------------------------------------------------------------

  it('marks event.outcome as failure for 4xx responses', async () => {
    const app = buildApp()
    const res = await request(app, '/not-found')

    expect(res.status).toBe(404)
    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'http.response.status_code': 404,
      'event.outcome': 'failure',
    })
  })

  it('marks event.outcome as failure for 5xx responses', async () => {
    const app = buildApp()
    const res = await request(app, '/server-error')

    expect(res.status).toBe(500)
    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'http.response.status_code': 500,
      'event.outcome': 'failure',
    })
  })

  // -------------------------------------------------------------------------
  // Handler-thrown errors
  // Hono catches handler/middleware errors internally and produces a 500
  // response. The middleware sees status 500 in the try-path, not catch.
  // -------------------------------------------------------------------------

  it('marks failure for handler-thrown errors (caught by Hono)', async () => {
    const app = buildApp()
    const res = await request(app, '/boom')

    expect(res.status).toBe(500)
    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'http.response.status_code': 500,
      'event.outcome': 'failure',
    })
  })

  // -------------------------------------------------------------------------
  // catch block — test directly by invoking the middleware with a rejecting
  // next(), bypassing Hono's compose (which swallows errors).
  // -------------------------------------------------------------------------

  it('captures error and re-throws when next() rejects', async () => {
    const middleware = wideEventMiddleware()
    const error = new Error('something broke')

    // Minimal Hono-like context stub
    const fakeContext = {
      req: { method: 'GET', path: '/test' },
      res: { status: 200 },
      set: () => {},
    } as unknown as Context

    const rejectingNext = () => Promise.reject(error)

    await expect(middleware(fakeContext, rejectingNext)).rejects.toThrow('something broke')

    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'something broke',
      'event.outcome': 'failure',
    })
  })

  // -------------------------------------------------------------------------
  // Handler enrichment
  // -------------------------------------------------------------------------

  it('makes wideEvent available on context for handler enrichment', async () => {
    const app = buildApp((c) => {
      const ev = c.get('wideEvent')
      expect(ev).toBeDefined()
      expect(ev).toBeInstanceOf(WideEvent)
      ;(ev as WideEvent).set('custom.field', 'hello')
      return c.text('OK')
    })

    const res = await request(app, '/ok')
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].properties).toMatchObject({
      'custom.field': 'hello',
      'event.outcome': 'success',
    })
  })

  // -------------------------------------------------------------------------
  // Custom options
  // -------------------------------------------------------------------------

  it('uses custom logger category when provided', async () => {
    const app = new Hono()
    app.use('*', wideEventMiddleware({ category: ['catalyst', 'wide'] }))
    app.get('/test', (c) => c.text('OK'))

    const res = await request(app, '/test')
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
  })

  it('emits nothing for unconfigured category', async () => {
    const app = new Hono()
    app.use('*', wideEventMiddleware({ category: ['unconfigured', 'category'] }))
    app.get('/test', (c) => c.text('OK'))

    const res = await request(app, '/test')
    expect(res.status).toBe(200)
    // The spy sink is only configured for ['catalyst', 'wide'], so nothing captured
    expect(captured).toHaveLength(0)
  })
})
