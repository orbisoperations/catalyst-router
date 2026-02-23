import { describe, it, expect, vi } from 'vitest'
import { trace } from '@opentelemetry/api'
import type { Logger } from '@logtape/logtape'
import type { Meter } from '@opentelemetry/api'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import type { CatalystConfig } from '@catalyst/config'

// Lazy import to let mock setup run first if needed
const { EnvoyService } = await import('../../src/service.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNoopTelemetry(name = 'envoy'): ServiceTelemetry {
  const childLogger = {
    debug: vi.fn(() => {}),
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    fatal: vi.fn(() => {}),
    getChild: vi.fn(() => childLogger),
  }

  const logger = {
    debug: vi.fn(() => {}),
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    fatal: vi.fn(() => {}),
    getChild: vi.fn(() => childLogger),
  }

  return {
    serviceName: name,
    logger: logger as unknown as Logger,
    meter: {
      createCounter: vi.fn(() => ({ add: vi.fn(() => {}) })),
      createHistogram: vi.fn(() => ({ record: vi.fn(() => {}) })),
      createUpDownCounter: vi.fn(() => ({ add: vi.fn(() => {}) })),
      createObservableCounter: vi.fn(() => ({})),
      createObservableGauge: vi.fn(() => ({})),
      createObservableUpDownCounter: vi.fn(() => ({})),
      createGauge: vi.fn(() => ({})),
    } as unknown as Meter,
    tracer: trace.getTracer('test-noop'),
    instrumentRpc: <T extends object>(t: T) => t,
  }
}

function createMinimalConfig(overrides: Partial<CatalystConfig> = {}): CatalystConfig {
  return {
    node: {
      name: 'test-node',
      domains: ['test.local'],
    },
    port: 3000,
    ...overrides,
  } as CatalystConfig
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnvoyService', () => {
  describe('service identity', () => {
    it('has name "envoy"', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      expect(service.info.name).toBe('envoy')
    })

    it('has version "0.0.0"', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      expect(service.info.version).toBe('0.0.0')
    })
  })

  describe('lifecycle', () => {
    it('transitions to "ready" after create()', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      expect(service.state).toBe('ready')
    })

    it('transitions to "stopped" after shutdown()', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      await service.shutdown()
      expect(service.state).toBe('stopped')
    })

    it('exposes config passed at construction', async () => {
      const config = createMinimalConfig({ port: 4567 })
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      expect(service.config.port).toBe(4567)
    })
  })

  describe('handler', () => {
    it('has a handler (Hono instance)', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      expect(service.handler).toBeDefined()
      expect(service.handler.fetch).toBeTypeOf('function')
    })

    it('responds to GET / with service banner', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      const req = new Request('http://localhost/')
      const res = await service.handler.fetch(req)

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('Envoy')
    })

    it('mounts RPC handler at /api', async () => {
      const config = createMinimalConfig()
      const telemetry = createNoopTelemetry()
      const service = await EnvoyService.create({ config, telemetry })

      // A GET to /api should not 404 — the RPC handler is mounted there
      const req = new Request('http://localhost/api')
      const res = await service.handler.fetch(req)

      // WebSocket upgrade endpoint returns 101 or the handler itself responds
      // Either way, it should not be 404
      expect(res.status).not.toBe(404)
    })
  })
})
