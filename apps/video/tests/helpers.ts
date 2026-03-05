import { trace } from '@opentelemetry/api'
import type { Logger } from '@logtape/logtape'
import type { Meter } from '@opentelemetry/api'
import type { ServiceTelemetry } from '@catalyst/telemetry'

export function createTestTelemetry(): ServiceTelemetry {
  const noop = () => {}
  const noopLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    getChild: () => noopLogger,
  }

  const noopMeter = {
    createCounter: () => ({ add: noop }),
    createHistogram: () => ({ record: noop }),
    createUpDownCounter: () => ({ add: noop }),
    createObservableCounter: () => ({}),
    createObservableGauge: () => ({}),
    createObservableUpDownCounter: () => ({}),
    createGauge: () => ({}),
  }

  return {
    serviceName: 'video-test',
    logger: noopLogger as unknown as Logger,
    meter: noopMeter as unknown as Meter,
    tracer: trace.getTracer('test-noop'),
    instrumentRpc: <T extends object>(t: T) => t,
  }
}
