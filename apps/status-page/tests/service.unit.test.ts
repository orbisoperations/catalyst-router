import { describe, it, expect } from 'vitest'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { CatalystConfig } from '@catalyst/config'
import { StatusPageService } from '../src/service.js'

const TEST_CONFIG: CatalystConfig = {
  node: {
    name: 'test-node',
    domains: ['test.local'],
    endpoint: 'http://localhost:4040',
  },
  port: 4040,
}

describe('StatusPageService', () => {
  const noopTelemetry = TelemetryBuilder.noop('status-page')

  it('has correct service info', () => {
    const service = new StatusPageService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    expect(service.info.name).toBe('status-page')
    expect(service.info.version).toBe('0.0.0')
  })

  it('loads default backend config', () => {
    const service = new StatusPageService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    expect(service.backends.prometheusUrl).toBe('http://prometheus:9090')
    expect(service.backends.jaegerUrl).toBe('http://jaeger:16686')
    expect(service.backends.influxdbUrl).toBe('http://influxdb:8086')
  })

  it('initializes and transitions to ready', async () => {
    const service = new StatusPageService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await service.initialize()
    expect(service.state).toBe('ready')
  })

  it('exposes /api/status route after initialization', async () => {
    const service = new StatusPageService({ config: TEST_CONFIG, telemetry: noopTelemetry })
    await service.initialize()

    const res = await service.handler.request('/api/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backends).toEqual({
      prometheus: 'http://prometheus:9090',
      jaeger: 'http://jaeger:16686',
      influxdb: 'http://influxdb:8086',
    })
  })
})
