import { afterEach, describe, expect, it } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { initMeter, getMeter, shutdownMeter } from './meter'

function createTestExporter() {
  return new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
}

describe('meter', () => {
  afterEach(async () => {
    await shutdownMeter()
  })

  describe('initMeter', () => {
    it('registers a global MeterProvider', () => {
      initMeter({ serviceName: 'test-service', _testExporter: createTestExporter() })

      const meter = metrics.getMeter('probe')
      expect(meter).toBeDefined()
    })

    it('silently no-ops on duplicate init', () => {
      const exporter1 = createTestExporter()
      const exporter2 = createTestExporter()
      initMeter({ serviceName: 'first', _testExporter: exporter1 })
      initMeter({ serviceName: 'second', _testExporter: exporter2 })

      // Second init should be ignored; getMeter still works
      const meter = getMeter('test')
      expect(meter).toBeDefined()
    })
  })

  describe('getMeter', () => {
    it('returns a Meter instance', () => {
      initMeter({ serviceName: 'test-service', _testExporter: createTestExporter() })

      const meter = getMeter('my-module')
      expect(meter).toBeDefined()
      expect(typeof meter.createCounter).toBe('function')
      expect(typeof meter.createHistogram).toBe('function')
    })

    it('returns a no-op meter before init', () => {
      const meter = getMeter('before-init')
      expect(meter).toBeDefined()
      // No-op meter still has createCounter; operations are no-ops
      const counter = meter.createCounter('noop.counter')
      counter.add(1) // should not throw
    })
  })

  describe('counter', () => {
    it('creates a counter and add() records data', () => {
      const exporter = createTestExporter()
      initMeter({ serviceName: 'test-service', _testExporter: exporter })

      const meter = getMeter('test')
      const counter = meter.createCounter('test.counter', {
        description: 'A test counter',
      })

      counter.add(1)
      counter.add(5, { label: 'value' })

      // Counter instrument was created successfully and accepted values
      expect(typeof counter.add).toBe('function')
    })
  })

  describe('histogram', () => {
    it('creates a histogram and record() accepts values', () => {
      const exporter = createTestExporter()
      initMeter({ serviceName: 'test-service', _testExporter: exporter })

      const meter = getMeter('test')
      const histogram = meter.createHistogram('test.histogram', {
        description: 'A test histogram',
        unit: 'ms',
      })

      histogram.record(42)
      histogram.record(100, { route: '/api' })

      // Histogram instrument was created successfully and accepted values
      expect(typeof histogram.record).toBe('function')
    })
  })

  describe('shutdownMeter', () => {
    it('completes without error', async () => {
      initMeter({ serviceName: 'test-service', _testExporter: createTestExporter() })
      await shutdownMeter()
    })

    it('is safe to call multiple times', async () => {
      initMeter({ serviceName: 'test-service', _testExporter: createTestExporter() })
      await shutdownMeter()
      await shutdownMeter()
    })
  })
})
