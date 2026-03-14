/**
 * WideEvent unit tests — uses spy loggers, zero global state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '@logtape/logtape'
import { WideEvent } from '../src/wide-event.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal spy logger that records calls to all levels. */
function createSpyLogger() {
  const calls: { level: string; message: string; properties: Record<string, unknown> }[] = []
  const makeSpy = (level: string) =>
    vi.fn((message: unknown, properties?: unknown) => {
      calls.push({
        level,
        message: message as string,
        properties: properties as Record<string, unknown>,
      })
    })

  const debugSpy = makeSpy('debug')
  const infoSpy = makeSpy('info')
  const warnSpy = makeSpy('warn')
  const errorSpy = makeSpy('error')

  const logger = {
    category: ['test'],
    parent: null,
    getChild: vi.fn(),
    with: vi.fn(),
    trace: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    warning: vi.fn(),
    error: errorSpy,
    fatal: vi.fn(),
    emit: vi.fn(),
    isEnabledFor: vi.fn(() => true),
  } as unknown as Logger

  return { logger, calls, debugSpy, infoSpy, warnSpy, errorSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WideEvent', () => {
  let logger: Logger
  let calls: { level: string; message: string; properties: Record<string, unknown> }[]
  let infoSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const spy = createSpyLogger()
    logger = spy.logger
    calls = spy.calls
    infoSpy = spy.infoSpy
    errorSpy = spy.errorSpy
  })

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  it('emits a single log record with all accumulated fields', () => {
    const ev = new WideEvent('http.request', logger)
    ev.set('http.request.method', 'GET')
    ev.set('url.path', '/api/health')
    ev.emit()

    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)

    const [record] = calls
    expect(record.level).toBe('info')
    expect(record.message).toBe('http.request completed')
    expect(record.properties).toMatchObject({
      'event.name': 'http.request',
      'http.request.method': 'GET',
      'url.path': '/api/health',
      'catalyst.event.outcome': 'success',
    })
    expect(record.properties['catalyst.event.duration_ms']).toBeTypeOf('number')
    expect(record.properties['catalyst.event.duration_ms']).toBeGreaterThanOrEqual(0)
  })

  it('does not emit twice', () => {
    const ev = new WideEvent('test.op', logger)
    ev.emit()
    ev.emit()
    ev.emit()

    expect(infoSpy).toHaveBeenCalledOnce()
  })

  it('defaults event.outcome to success when not explicitly set', () => {
    const ev = new WideEvent('test.op', logger)
    ev.emit()

    expect(calls[0].properties['catalyst.event.outcome']).toBe('success')
  })

  it('does not override an explicit event.outcome', () => {
    const ev = new WideEvent('test.op', logger)
    ev.set('catalyst.event.outcome', 'partial')
    ev.emit()

    expect(calls[0].properties['catalyst.event.outcome']).toBe('partial')
  })

  // -------------------------------------------------------------------------
  // set()
  // -------------------------------------------------------------------------

  it('set() with key-value pair sets a single field', () => {
    const ev = new WideEvent('test.op', logger)
    ev.set('host', 'localhost')
    ev.emit()

    expect(calls[0].properties['host']).toBe('localhost')
  })

  it('set() with object merges multiple fields', () => {
    const ev = new WideEvent('test.op', logger)
    ev.set({ alpha: 1, beta: 'two' })
    ev.emit()

    expect(calls[0].properties).toMatchObject({ alpha: 1, beta: 'two' })
  })

  it('set() returns this for chaining', () => {
    const ev = new WideEvent('test.op', logger)
    const result = ev.set('a', 1).set({ b: 2 }).set('c', 3)

    expect(result).toBe(ev)

    ev.emit()
    expect(calls[0].properties).toMatchObject({ a: 1, b: 2, c: 3 })
  })

  it('later set() calls overwrite earlier values for the same key', () => {
    const ev = new WideEvent('test.op', logger)
    ev.set('key', 'first')
    ev.set('key', 'second')
    ev.emit()

    expect(calls[0].properties['key']).toBe('second')
  })

  // -------------------------------------------------------------------------
  // setError()
  // -------------------------------------------------------------------------

  it('setError marks outcome as failure, captures Error fields, and emits at error level', () => {
    const ev = new WideEvent('test.op', logger)
    ev.setError(new TypeError('bad input'))
    ev.emit()

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(calls[0].level).toBe('error')
    expect(calls[0].properties).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'bad input',
      'catalyst.event.outcome': 'failure',
    })
    expect(calls[0].properties['exception.stacktrace']).toBeTypeOf('string')
    expect(calls[0].properties['exception.stacktrace']).toContain('TypeError')
  })

  it('setError handles non-Error values', () => {
    const ev = new WideEvent('test.op', logger)
    ev.setError('string error')
    ev.emit()

    expect(calls[0].level).toBe('error')
    expect(calls[0].properties).toMatchObject({
      'exception.type': 'string',
      'exception.message': 'string error',
      'catalyst.event.outcome': 'failure',
    })
  })

  it('setError handles numeric thrown values', () => {
    const ev = new WideEvent('test.op', logger)
    ev.setError(42)
    ev.emit()

    expect(calls[0].level).toBe('error')
    expect(calls[0].properties).toMatchObject({
      'exception.type': 'number',
      'exception.message': '42',
      'catalyst.event.outcome': 'failure',
    })
  })

  it('setError returns this for chaining', () => {
    const ev = new WideEvent('test.op', logger)
    const result = ev.setError(new Error('oops'))

    expect(result).toBe(ev)
  })

  // -------------------------------------------------------------------------
  // Duration tracking
  // -------------------------------------------------------------------------

  it('computes event.duration_ms as a non-negative number', () => {
    const ev = new WideEvent('test.op', logger)
    ev.emit()

    const duration = calls[0].properties['catalyst.event.duration_ms'] as number
    expect(duration).toBeTypeOf('number')
    expect(duration).toBeGreaterThanOrEqual(0)
  })

  // -------------------------------------------------------------------------
  // event.log (correlated intermediate logging)
  // -------------------------------------------------------------------------

  it('event.log.info injects event.name into properties', () => {
    const ev = new WideEvent('gateway.reload', logger)
    ev.log.info('SDL validated for {url}', { url: 'http://svc:4000/graphql' })

    expect(calls).toHaveLength(1)
    expect(calls[0].level).toBe('info')
    expect(calls[0].message).toBe('SDL validated for {url}')
    expect(calls[0].properties).toMatchObject({
      'event.name': 'gateway.reload',
      url: 'http://svc:4000/graphql',
    })
  })

  it('event.log.warn preserves warn severity', () => {
    const ev = new WideEvent('envoy.route_update', logger)
    ev.log.warn('legacy port derivation', { legacy: true })

    expect(calls[0].level).toBe('warn')
    expect(calls[0].properties['event.name']).toBe('envoy.route_update')
  })

  it('event.log calls are independent from the final emit', () => {
    const ev = new WideEvent('test.op', logger)
    ev.log.info('step 1')
    ev.log.debug('step 2')
    ev.set('result', 'ok')
    ev.emit()

    // 2 intermediate logs + 1 final emit = 3 calls
    expect(calls).toHaveLength(3)
    expect(calls[0].level).toBe('info')
    expect(calls[1].level).toBe('debug')
    expect(calls[2].level).toBe('info')
    expect(calls[2].message).toBe('test.op completed')
  })

  it('event.log returns the same instance on repeated access', () => {
    const ev = new WideEvent('test.op', logger)
    expect(ev.log).toBe(ev.log)
  })
})
