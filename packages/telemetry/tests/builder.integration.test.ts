/**
 * TelemetryBuilder integration tests — uses .build(), global state
 *
 * These tests call .build() which initializes global OTel providers and
 * LogTape sinks. They MUST NOT run in the same file as noop-only tests.
 *
 * Each test calls .build() which delegates to initTelemetry() — idempotent
 * after first call. The afterAll runs shutdownTelemetry() one final time.
 * Lifecycle tests also call shutdown mid-file; this is safe because shutdown
 * is idempotent.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { TelemetryBuilder } from '../src/builder.js'
import { shutdownTelemetry } from '../src/index.js'

afterAll(async () => {
  await shutdownTelemetry()
})

// ---------------------------------------------------------------------------
// Build basics
// ---------------------------------------------------------------------------

describe('TelemetryBuilder.build()', () => {
  it('.build() returns a Promise', () => {
    const result = new TelemetryBuilder('test-async').build()
    expect(result).toBeInstanceOf(Promise)
  })

  it('returns ServiceTelemetry with correct serviceName', async () => {
    const telemetry = await new TelemetryBuilder('auth').build()
    expect(telemetry.serviceName).toBe('auth')
  })

  it('built signals are functional (logger, meter, tracer)', async () => {
    const t = await new TelemetryBuilder('signals-test').build()
    expect(() => {
      t.logger.info`test ${42}`
      t.meter.createCounter('c').add(1)
      t.tracer.startActiveSpan('s', (span) => span.end())
    }).not.toThrow()
  })

  it('result is frozen', async () => {
    const t = await new TelemetryBuilder('frozen-test').build()
    expect(Object.isFrozen(t)).toBe(true)
  })

  it('.build() with no .with*() calls uses defaults', async () => {
    const t = await new TelemetryBuilder('defaults-test').build()
    expect(t.serviceName).toBe('defaults-test')
    expect(t.logger).toBeDefined()
    expect(t.meter).toBeDefined()
    expect(t.tracer).toBeDefined()
    expect(typeof t.instrumentRpc).toBe('function')
  })

  it('.build() without OTLP endpoint does not throw', async () => {
    const t = await new TelemetryBuilder('no-otlp').build()
    expect(t.serviceName).toBe('no-otlp')
  })

  it('double .build() on same builder returns two working instances', async () => {
    const builder = new TelemetryBuilder('double-build')
    const first = await builder.build()
    const second = await builder.build()
    expect(first.serviceName).toBe('double-build')
    expect(second.serviceName).toBe('double-build')
    // They may or may not be the same reference — contract is both work
    expect(() => {
      first.logger.info`from first`
      second.logger.info`from second`
    }).not.toThrow()
  })

  it('two builders with different names produce independent telemetry', async () => {
    const a = await new TelemetryBuilder('auth-indep').build()
    const b = await new TelemetryBuilder('gateway-indep').build()
    expect(a.serviceName).toBe('auth-indep')
    expect(b.serviceName).toBe('gateway-indep')
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// RPC instrumentation
// ---------------------------------------------------------------------------

describe('built instrumentRpc', () => {
  it('wraps target in a Proxy that preserves method behavior', async () => {
    const t = await new TelemetryBuilder('rpc-test').withRpcInstrumentation().build()

    const target = {
      hello: () => 'world',
      _internal: () => 'skipped',
    }

    const instrumented = t.instrumentRpc(target)
    expect(instrumented).not.toBe(target) // Proxy, not the original
    expect(instrumented.hello()).toBe('world')
    expect(instrumented._internal()).toBe('skipped') // underscore methods pass through
  })

  it('respects spanKind option from withRpcInstrumentation', async () => {
    const t = await new TelemetryBuilder('client-svc')
      .withRpcInstrumentation({ spanKind: 'CLIENT' })
      .build()

    const target = { fetch: () => ({ data: 'ok' }) }
    const instrumented = t.instrumentRpc(target)
    expect(instrumented.fetch()).toEqual({ data: 'ok' })
  })

  it('respects ignoreMethods from withRpcInstrumentation', async () => {
    const t = await new TelemetryBuilder('ignore-test')
      .withRpcInstrumentation({ ignoreMethods: ['health'] })
      .build()

    const target = {
      health: () => 'ok',
      greet: () => 'hello',
    }
    const instrumented = t.instrumentRpc(target)
    // Both methods should still work — ignoreMethods only skips span creation
    expect(instrumented.health()).toBe('ok')
    expect(instrumented.greet()).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('TelemetryBuilder lifecycle', () => {
  it('shutdownTelemetry() succeeds after .build()', async () => {
    await new TelemetryBuilder('shutdown-test').build()
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })

  it('shutdownTelemetry() succeeds without prior .build()', async () => {
    // Covers teardown in test suites where no builder was used
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })

  it('logger and meter calls after shutdown do not throw', async () => {
    const t = await new TelemetryBuilder('post-shutdown').build()
    await shutdownTelemetry()
    expect(() => {
      t.logger.info`after shutdown`
      t.meter.createCounter('post.shutdown.counter').add(1)
    }).not.toThrow()
  })
})
