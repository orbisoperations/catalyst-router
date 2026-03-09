/**
 * WideEvent unit tests — uses spy loggers, zero global state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '@logtape/logtape'
import { WideEvent } from '../src/wide-event.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal spy logger that records calls to .info() and .error() */
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

  const infoSpy = makeSpy('info')
  const errorSpy = makeSpy('error')

  const logger = {
    category: ['test'],
    parent: null,
    getChild: vi.fn(),
    with: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    warning: vi.fn(),
    error: errorSpy,
    fatal: vi.fn(),
    emit: vi.fn(),
    isEnabledFor: vi.fn(() => true),
  } as unknown as Logger

  return { logger, calls, infoSpy, errorSpy }
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
    ev.set('http.method', 'GET')
    ev.set('http.path', '/api/health')
    ev.emit()

    expect(infoSpy).toHaveBeenCalledOnce()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)

    const [record] = calls
    expect(record.level).toBe('info')
    expect(record.message).toBe('http.request completed')
    expect(record.properties).toMatchObject({
      'event.name': 'http.request',
      'http.method': 'GET',
      'http.path': '/api/health',
      'event.outcome': 'success',
    })
    expect(record.properties['event.duration_ms']).toBeTypeOf('number')
    expect(record.properties['event.duration_ms']).toBeGreaterThanOrEqual(0)
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

    expect(calls[0].properties['event.outcome']).toBe('success')
  })

  it('does not override an explicit event.outcome', () => {
    const ev = new WideEvent('test.op', logger)
    ev.set('event.outcome', 'partial')
    ev.emit()

    expect(calls[0].properties['event.outcome']).toBe('partial')
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
      'error.type': 'TypeError',
      'error.message': 'bad input',
      'event.outcome': 'failure',
    })
  })

  it('setError handles non-Error values', () => {
    const ev = new WideEvent('test.op', logger)
    ev.setError('string error')
    ev.emit()

    expect(calls[0].level).toBe('error')
    expect(calls[0].properties).toMatchObject({
      'error.type': 'string',
      'error.message': 'string error',
      'event.outcome': 'failure',
    })
  })

  it('setError handles numeric thrown values', () => {
    const ev = new WideEvent('test.op', logger)
    ev.setError(42)
    ev.emit()

    expect(calls[0].level).toBe('error')
    expect(calls[0].properties).toMatchObject({
      'error.type': 'number',
      'error.message': '42',
      'event.outcome': 'failure',
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

    const duration = calls[0].properties['event.duration_ms'] as number
    expect(duration).toBeTypeOf('number')
    expect(duration).toBeGreaterThanOrEqual(0)
  })
})
