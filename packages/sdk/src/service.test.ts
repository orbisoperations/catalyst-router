import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { CatalystService } from './service'

describe('CatalystService', () => {
  let service: CatalystService

  afterEach(async () => {
    if (service) {
      // Use a short timeout to avoid hanging on tests with stuck callbacks
      await service.shutdown(500)
    }
  })

  describe('constructor', () => {
    it('creates an instance with required options', () => {
      service = new CatalystService({ name: 'test-service' })
      expect(service).toBeInstanceOf(CatalystService)
    })

    it('exposes a Hono app', () => {
      service = new CatalystService({ name: 'test-service' })
      expect(service.app).toBeInstanceOf(Hono)
    })

    it('throws on empty service name', () => {
      expect(() => new CatalystService({ name: '' })).toThrow(
        '[CatalystService] name is required and must be non-empty'
      )
    })

    it('throws on whitespace-only service name', () => {
      expect(() => new CatalystService({ name: '   ' })).toThrow(
        '[CatalystService] name is required and must be non-empty'
      )
    })

    it('exposes the service name via accessor', () => {
      service = new CatalystService({ name: 'my-api' })
      expect(service.name).toBe('my-api')
    })

    it('uses default port 3000 when not specified', () => {
      service = new CatalystService({ name: 'test-service' })
      expect(service.port).toBe(3000)
    })

    it('accepts custom port', () => {
      service = new CatalystService({ name: 'test-service', port: 8080 })
      expect(service.port).toBe(8080)
    })

    it('uses default hostname 0.0.0.0 when not specified', () => {
      service = new CatalystService({ name: 'test-service' })
      expect(service.hostname).toBe('0.0.0.0')
    })

    it('accepts custom hostname', () => {
      service = new CatalystService({ name: 'test-service', hostname: '127.0.0.1' })
      expect(service.hostname).toBe('127.0.0.1')
    })
  })

  describe('health endpoint', () => {
    it('responds 200 on /health by default', async () => {
      service = new CatalystService({ name: 'test-service' })
      const res = await service.app.request('/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ status: 'ok' })
    })

    it('uses custom health path when configured', async () => {
      service = new CatalystService({
        name: 'test-service',
        healthPath: '/ready',
      })
      const res = await service.app.request('/ready')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ status: 'ok' })
    })
  })

  describe('serve', () => {
    it('returns an object with fetch, port, hostname, and websocket', () => {
      service = new CatalystService({ name: 'test-service', port: 4000 })
      const config = service.serve()
      expect(config.port).toBe(4000)
      expect(config.hostname).toBe('0.0.0.0')
      expect(typeof config.fetch).toBe('function')
      expect(config.websocket).toBeDefined()
    })

    it('returns custom hostname in serve config', () => {
      service = new CatalystService({ name: 'test-service', hostname: '127.0.0.1' })
      const config = service.serve()
      expect(config.hostname).toBe('127.0.0.1')
    })

    it('returns a bound fetch that works without Hono this context', async () => {
      service = new CatalystService({ name: 'test-service' })
      service.app.get('/ping', (c) => c.text('pong'))

      const { fetch } = service.serve()
      // Call fetch as a standalone function (simulates Bun runtime)
      const res = await fetch(new Request('http://localhost/ping'))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('pong')
    })
  })

  describe('shutdown', () => {
    it('calls registered onShutdown callbacks', async () => {
      service = new CatalystService({ name: 'test-service' })
      const fn1 = vi.fn()
      const fn2 = vi.fn()
      service.onShutdown(fn1)
      service.onShutdown(fn2)

      await service.shutdown()

      expect(fn1).toHaveBeenCalledOnce()
      expect(fn2).toHaveBeenCalledOnce()
    })

    it('handles async shutdown callbacks', async () => {
      service = new CatalystService({ name: 'test-service' })
      let resolved = false
      service.onShutdown(async () => {
        await new Promise((r) => setTimeout(r, 10))
        resolved = true
      })

      await service.shutdown()
      expect(resolved).toBe(true)
    })

    it('logs errors from shutdown callbacks but does not throw', async () => {
      service = new CatalystService({ name: 'test-service' })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      service.onShutdown(() => {
        throw new Error('shutdown boom')
      })

      await expect(service.shutdown()).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('runs callbacks in registration order', async () => {
      service = new CatalystService({ name: 'test-service' })
      const order: number[] = []
      service.onShutdown(() => {
        order.push(1)
      })
      service.onShutdown(() => {
        order.push(2)
      })
      service.onShutdown(() => {
        order.push(3)
      })

      await service.shutdown()
      expect(order).toEqual([1, 2, 3])
    })

    it('times out if a callback hangs', async () => {
      service = new CatalystService({ name: 'test-service' })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      service.onShutdown(
        () => new Promise(() => {}) // never resolves
      )

      // Use a short timeout (100ms) for the test
      await service.shutdown(100)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[test-service]'),
        expect.stringContaining('timed out')
      )
      consoleSpy.mockRestore()
    })
  })

  describe('OTEL accessors (no telemetry)', () => {
    it('exposes no-op tracer when telemetry is not initialized', () => {
      service = new CatalystService({ name: 'test-service' })
      const tracer = service.tracer
      expect(tracer).toBeDefined()
      // No-op tracer should still have startSpan
      expect(typeof tracer.startSpan).toBe('function')
    })

    it('exposes no-op meter when telemetry is not initialized', () => {
      service = new CatalystService({ name: 'test-service' })
      const meter = service.meter
      expect(meter).toBeDefined()
      // No-op meter should still have createCounter
      expect(typeof meter.createCounter).toBe('function')
    })
  })

  describe('custom routes', () => {
    it('allows mounting routes on the app after construction', async () => {
      service = new CatalystService({ name: 'test-service' })
      service.app.get('/custom', (c) => c.text('hello'))

      const res = await service.app.request('/custom')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello')
    })
  })
})
