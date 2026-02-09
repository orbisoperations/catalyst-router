import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { CatalystService } from '../src/catalyst-service.js'
import type { CatalystServiceOptions, ServiceInfo } from '../src/types.js'
import type { CatalystConfig } from '@catalyst/config'

const TEST_CONFIG: CatalystConfig = {
  node: {
    name: 'test-node',
    domains: ['test.local'],
    endpoint: 'http://localhost:3000',
  },
  port: 3000,
}

class TestService extends CatalystService {
  readonly info: ServiceInfo = { name: 'test', version: '1.0.0' }
  readonly handler = new Hono()
  initCalled = false
  shutdownCalled = false

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected override async onInitialize(): Promise<void> {
    this.initCalled = true
    this.handler.get('/ping', (c) => c.text('pong'))
  }

  protected override async onShutdown(): Promise<void> {
    this.shutdownCalled = true
  }
}

class FailingService extends CatalystService {
  readonly info: ServiceInfo = { name: 'failing', version: '0.0.0' }
  readonly handler = new Hono()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected override async onInitialize(): Promise<void> {
    throw new Error('init failed')
  }
}

describe('CatalystService', () => {
  const noopTelemetry = TelemetryBuilder.noop('test')

  it('starts in created state', () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    expect(svc.state).toBe('created')
    expect(svc.initCalled).toBe(false)
  })

  it('throws if telemetry accessed before init', () => {
    const svc = new TestService({ config: TEST_CONFIG })
    expect(() => svc.telemetry).toThrow(/not initialized/)
  })

  it('initializes and transitions to ready', async () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await svc.initialize()
    expect(svc.state).toBe('ready')
    expect(svc.initCalled).toBe(true)
    expect(svc.telemetry).toBeDefined()
    expect(svc.telemetry.serviceName).toBe('test')
  })

  it('registers routes on handler during init', async () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await svc.initialize()

    const res = await svc.handler.request('/ping')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
  })

  it('prevents double initialization', async () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await svc.initialize()
    await expect(svc.initialize()).rejects.toThrow(/Cannot initialize/)
  })

  it('transitions to stopped on init failure', async () => {
    const svc = new FailingService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await expect(svc.initialize()).rejects.toThrow('init failed')
    expect(svc.state).toBe('stopped')
  })

  it('shuts down cleanly', async () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await svc.initialize()
    await svc.shutdown()
    expect(svc.state).toBe('stopped')
    expect(svc.shutdownCalled).toBe(true)
  })

  it('shutdown is idempotent (no-op if not ready)', async () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    // Not initialized — shutdown should be a no-op
    await svc.shutdown()
    expect(svc.state).toBe('created')
    expect(svc.shutdownCalled).toBe(false)
  })

  it('exposes config from constructor', () => {
    const svc = new TestService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    expect(svc.config).toBe(TEST_CONFIG)
    expect(svc.config.node.name).toBe('test-node')
  })

  it('uses pre-built telemetry when provided', async () => {
    const telemetry = TelemetryBuilder.noop('custom')
    const svc = new TestService({ config: TEST_CONFIG, telemetry })
    await svc.initialize()
    expect(svc.telemetry).toBe(telemetry)
  })

  describe('static create()', () => {
    it('creates and initializes in one call', async () => {
      const svc = await TestService.create({ config: TEST_CONFIG, telemetry: noopTelemetry })
      expect(svc.state).toBe('ready')
      expect(svc.initCalled).toBe(true)
      expect(svc).toBeInstanceOf(TestService)
    })
  })
})
