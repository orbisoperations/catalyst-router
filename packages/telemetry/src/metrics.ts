import { metrics, type Meter } from '@opentelemetry/api'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc'
import type { ChannelCredentials } from '@grpc/grpc-js'
import { buildResource } from './resource.js'
import { DEFAULT_SERVICE_NAME, EXPORT_TIMEOUT_MS, validateEnvironment } from './constants.js'

export interface MetricsConfig {
  serviceName?: string
  serviceVersion?: string
  environment?: string
  otlpEndpoint?: string
  exportIntervalMs?: number // default 60_000
  serviceInstanceId?: string
  credentials?: ChannelCredentials
}

let meterProvider: MeterProvider | null = null

/**
 * Create a MeterProvider with an OTLP exporter and register it globally.
 *
 * No-op if already configured or if `OTEL_EXPORTER_OTLP_ENDPOINT` is not
 * set (either via `config.otlpEndpoint` or the environment variable).
 */
export function configureMetrics(config?: MetricsConfig): void {
  if (meterProvider) return

  const serviceName = config?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME
  const serviceVersion = config?.serviceVersion ?? process.env.OTEL_SERVICE_VERSION
  const environment = config?.environment ?? validateEnvironment(process.env.NODE_ENV)
  const otlpEndpoint = config?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  if (!otlpEndpoint) return

  const serviceInstanceId = config?.serviceInstanceId
  const resource = buildResource({ serviceName, serviceVersion, environment, serviceInstanceId })

  const exporter = new OTLPMetricExporter({
    url: otlpEndpoint,
    timeoutMillis: EXPORT_TIMEOUT_MS,
    ...(config?.credentials ? { credentials: config.credentials } : {}),
  })

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: config?.exportIntervalMs ?? 60_000,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  })

  meterProvider = new MeterProvider({ resource, readers: [reader] })
  metrics.setGlobalMeterProvider(meterProvider)
}

/**
 * Flush pending metric exports and shut down the meter provider.
 * No-op if no provider was configured.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!meterProvider) return
  await meterProvider.shutdown()
  meterProvider = null
  metrics.disable()
}

/**
 * Return a named {@link Meter} from the global meter provider.
 * Returns a no-op meter if no provider has been configured.
 */
export function getMeter(name: string): Meter {
  return metrics.getMeter(name)
}
