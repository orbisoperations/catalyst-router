/**
 * TelemetryBuilder unit tests — noop-only, zero global state
 *
 * These tests exercise the builder API using only TelemetryBuilder.noop().
 * They never call .build() and never register global OTel providers.
 * Safe for parallel execution.
 */

import { describe, it, expect } from 'vitest'
import { TelemetryBuilder } from '../src/builder.js'

// ---------------------------------------------------------------------------
// Builder Construction
// ---------------------------------------------------------------------------

describe('TelemetryBuilder construction', () => {
  it('accepts a non-empty service name', () => {
    expect(new TelemetryBuilder('auth')).toBeInstanceOf(TelemetryBuilder)
  })

  it('throws on empty string', () => {
    expect(() => new TelemetryBuilder('')).toThrow()
  })

  it('throws on whitespace-only string', () => {
    expect(() => new TelemetryBuilder('  ')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Chainable API
// ---------------------------------------------------------------------------

describe('TelemetryBuilder chainable API', () => {
  it('all .with*() methods return the same builder instance', () => {
    const builder = new TelemetryBuilder('svc')
    expect(builder.withLogger()).toBe(builder)
    expect(builder.withMetrics()).toBe(builder)
    expect(builder.withTracing()).toBe(builder)
    expect(builder.withRpcInstrumentation()).toBe(builder)
  })

  it('methods can be chained in any order', () => {
    expect(
      new TelemetryBuilder('svc').withMetrics().withLogger().withTracing().withRpcInstrumentation()
    ).toBeInstanceOf(TelemetryBuilder)
  })
})

// ---------------------------------------------------------------------------
// Noop Factory
// ---------------------------------------------------------------------------

describe('TelemetryBuilder.noop()', () => {
  it('returns a ServiceTelemetry with correct serviceName', () => {
    const telemetry = TelemetryBuilder.noop('test-svc')
    expect(telemetry.serviceName).toBe('test-svc')
  })

  it('is synchronous (returns value, not Promise)', () => {
    const result = TelemetryBuilder.noop('test')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.serviceName).toBe('test')
  })

  it('has all required fields', () => {
    const t = TelemetryBuilder.noop('auth')
    expect(t).toHaveProperty('serviceName')
    expect(t).toHaveProperty('logger')
    expect(t).toHaveProperty('meter')
    expect(t).toHaveProperty('tracer')
    expect(typeof t.instrumentRpc).toBe('function')
  })

  it('noop logger accepts all levels with interpolation and produces no output', () => {
    const telemetry = TelemetryBuilder.noop('test')
    const calls: unknown[][] = []
    const orig = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    }
    console.log = (...args: unknown[]) => calls.push(args)
    console.error = (...args: unknown[]) => calls.push(args)
    console.warn = (...args: unknown[]) => calls.push(args)
    console.info = (...args: unknown[]) => calls.push(args)
    console.debug = (...args: unknown[]) => calls.push(args)
    try {
      const v = 42
      telemetry.logger.debug`debug ${v}`
      telemetry.logger.info`info ${v}`
      telemetry.logger.warn`warn ${v}`
      telemetry.logger.error`error ${v}`
      telemetry.logger.fatal`fatal ${v}`
    } finally {
      Object.assign(console, orig)
    }
    expect(calls).toHaveLength(0)
  })

  it('noop meter accepts counter and histogram recording', () => {
    const telemetry = TelemetryBuilder.noop('test')
    expect(() => {
      const counter = telemetry.meter.createCounter('test.counter')
      counter.add(1)
      counter.add(5, { key: 'value' })
      const histogram = telemetry.meter.createHistogram('test.histogram')
      histogram.record(1.5)
    }).not.toThrow()
  })

  it('noop tracer accepts span creation and ending', () => {
    const telemetry = TelemetryBuilder.noop('test')
    expect(() => {
      telemetry.tracer.startActiveSpan('test-span', (span) => {
        span.setAttribute('key', 'value')
        span.end()
      })
    }).not.toThrow()
  })

  it('noop instrumentRpc returns the target unchanged (with and without options)', () => {
    const telemetry = TelemetryBuilder.noop('test')
    const target = { foo: () => 'bar' }
    expect(telemetry.instrumentRpc(target)).toBe(target)
    expect(telemetry.instrumentRpc(target, { spanKind: 'CLIENT' })).toBe(target)
  })

  it('result is frozen (immutable)', () => {
    expect(Object.isFrozen(TelemetryBuilder.noop('test'))).toBe(true)
  })

  it('multiple noop instances do not interfere', () => {
    const a = TelemetryBuilder.noop('service-a')
    const b = TelemetryBuilder.noop('service-b')
    expect(a.serviceName).toBe('service-a')
    expect(b.serviceName).toBe('service-b')
    expect(a).not.toBe(b)
  })

  it('noop() does not validate serviceName (documents current behavior)', () => {
    const telemetry = TelemetryBuilder.noop('')
    expect(telemetry.serviceName).toBe('')
  })
})
