/**
 * @catalyst/telemetry — MeterProvider setup
 *
 * Initializes OpenTelemetry metrics with OTLP HTTP export
 * and PeriodicExportingMetricReader.
 */

import { metrics } from '@opentelemetry/api'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { buildResource } from './resource'

interface MeterOptions {
  serviceName: string
  serviceVersion?: string
  environment?: string
  otlpEndpoint?: string
  batch?: {
    exportIntervalMillis?: number
  }
  /** @internal Test-only: inject an in-memory exporter */
  _testExporter?: PushMetricExporter
}

let meterProvider: MeterProvider | null = null

export function initMeter(opts: MeterOptions): void {
  if (meterProvider) {
    console.warn('[telemetry] MeterProvider already initialized, ignoring duplicate initMeter call')
    return
  }

  const resource = buildResource(opts)

  const exporter =
    opts._testExporter ??
    new OTLPMetricExporter({
      url: `${opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/metrics`,
      /** WHY 5s: Same rationale as trace exporter — bounded shutdown time. */
      timeoutMillis: 5000,
    })

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: opts._testExporter ? 100 : (opts.batch?.exportIntervalMillis ?? 60_000),
  })

  meterProvider = new MeterProvider({
    resource,
    readers: [reader],
  })

  metrics.setGlobalMeterProvider(meterProvider)
}

export function getMeter(name: string): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter(name)
}

export async function shutdownMeter(): Promise<void> {
  if (!meterProvider) return
  const p = meterProvider
  meterProvider = null
  try {
    await p.shutdown()
  } finally {
    metrics.disable()
  }
}
