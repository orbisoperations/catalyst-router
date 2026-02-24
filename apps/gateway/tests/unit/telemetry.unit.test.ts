import { describe, it, expect, vi, afterEach } from 'vitest'
import { trace } from '@opentelemetry/api'
import type { Logger } from '@logtape/logtape'
import type { Meter } from '@opentelemetry/api'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { GatewayGraphqlServer } from '../../src/graphql/server.js'

// ---------------------------------------------------------------------------
// Spy factory — builds a ServiceTelemetry with observable instruments
// ---------------------------------------------------------------------------

function createSpyTelemetry() {
  const childLogger = {
    debug: vi.fn(() => {}),
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    fatal: vi.fn(() => {}),
    getChild: vi.fn(() => childLogger),
  }

  const getChildSpy = vi.fn(() => childLogger)

  const logger = {
    debug: vi.fn(() => {}),
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    fatal: vi.fn(() => {}),
    getChild: getChildSpy,
  }

  const counterAddSpy = vi.fn(() => {})
  const histogramRecordSpy = vi.fn(() => {})
  const upDownCounterAddSpy = vi.fn(() => {})

  const createCounterSpy = vi.fn(() => ({ add: counterAddSpy }))
  const createHistogramSpy = vi.fn(() => ({ record: histogramRecordSpy }))
  const createUpDownCounterSpy = vi.fn(() => ({ add: upDownCounterAddSpy }))

  const meter = {
    createCounter: createCounterSpy,
    createHistogram: createHistogramSpy,
    createUpDownCounter: createUpDownCounterSpy,
    createObservableCounter: vi.fn(() => ({})),
    createObservableGauge: vi.fn(() => ({})),
    createObservableUpDownCounter: vi.fn(() => ({})),
    createGauge: vi.fn(() => ({})),
  }

  const telemetry: ServiceTelemetry = {
    serviceName: 'gateway',
    logger: logger as unknown as Logger,
    meter: meter as unknown as Meter,
    tracer: trace.getTracer('test-noop'),
    instrumentRpc: <T extends object>(t: T) => t,
  }

  return {
    telemetry,
    spies: {
      getChild: getChildSpy,
      childLogger,
      counterAdd: counterAddSpy,
      histogramRecord: histogramRecordSpy,
      upDownCounterAdd: upDownCounterAddSpy,
      createCounter: createCounterSpy,
      createHistogram: createHistogramSpy,
      createUpDownCounter: createUpDownCounterSpy,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GatewayGraphqlServer telemetry DI', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('constructor calls telemetry.logger.getChild("graphql")', () => {
    const { telemetry, spies } = createSpyTelemetry()
    new GatewayGraphqlServer(telemetry)

    expect(spies.getChild).toHaveBeenCalledTimes(1)
    expect(spies.getChild).toHaveBeenCalledWith('graphql')
  })

  it('constructor creates metric instruments from the provided meter', () => {
    const { telemetry, spies } = createSpyTelemetry()
    new GatewayGraphqlServer(telemetry)

    expect(spies.createCounter).toHaveBeenCalledWith(
      'gateway.schema.reloads',
      expect.objectContaining({ description: expect.any(String) })
    )
    expect(spies.createHistogram).toHaveBeenCalledWith(
      'gateway.schema.reload.duration',
      expect.objectContaining({ description: expect.any(String) })
    )
    expect(spies.createUpDownCounter).toHaveBeenCalledWith(
      'gateway.subgraph.active',
      expect.objectContaining({ description: expect.any(String) })
    )
  })

  it('reload() with empty services records success metrics', async () => {
    const { telemetry, spies } = createSpyTelemetry()
    const server = new GatewayGraphqlServer(telemetry)

    const result = await server.reload({ services: [] })

    expect(result).toEqual({ success: true })
    expect(spies.counterAdd).toHaveBeenCalledWith(1, { result: 'success' })
    expect(spies.histogramRecord).toHaveBeenCalledWith(expect.any(Number))
  })

  it('reload() with unreachable service records failure metrics', async () => {
    const { telemetry, spies } = createSpyTelemetry()
    const server = new GatewayGraphqlServer(telemetry)

    // Mock fetch to reject — simulates unreachable service
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof globalThis.fetch

    const result = await server.reload({
      services: [{ name: 'bad', url: 'http://fail.test/graphql' }],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeTypeOf('string')
    }
    expect(spies.counterAdd).toHaveBeenCalledWith(1, { result: 'failure' })
    expect(spies.histogramRecord).toHaveBeenCalledWith(expect.any(Number))
  })

  it('reload() updates active subgraph gauge correctly', async () => {
    const { telemetry, spies } = createSpyTelemetry()
    const server = new GatewayGraphqlServer(telemetry)

    // First reload with empty services → delta should be 0 (0 - 0)
    await server.reload({ services: [] })
    expect(spies.upDownCounterAdd).toHaveBeenCalledWith(0)

    // Clear spies to isolate second call
    spies.upDownCounterAdd.mockClear()

    // Second reload still empty → delta should be 0 again (0 - 0)
    await server.reload({ services: [] })
    expect(spies.upDownCounterAdd).toHaveBeenCalledWith(0)
  })
})
