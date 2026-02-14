/**
 * @catalyst/telemetry — Manual tracer setup (Bun-compatible)
 *
 * Uses NodeTracerProvider + BatchSpanProcessor instead of NodeSDK
 * auto-instrumentation, which silently fails on Bun (patches Node.js
 * http internals that Bun doesn't use).
 *
 * Callers must call initTracer() explicitly — no side effects on import.
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
  TraceFlags,
  type Context,
  type Tracer,
} from '@opentelemetry/api'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import type { ChannelCredentials } from '@grpc/grpc-js'
import { EXPORT_TIMEOUT_MS } from './constants.js'
import { buildResource } from './resource.js'

let tracerProvider: NodeTracerProvider | null = null

const MAX_QUEUE_SIZE = 2048
const MAX_EXPORT_BATCH_SIZE = 512
const SCHEDULED_DELAY_MS = 5_000

type SamplingDecision = 0 | 1 | 2
interface Sampler {
  shouldSample(
    parentContext: unknown,
    traceId: string,
    spanName: string,
    spanKind: unknown,
    attributes: Record<string, unknown>,
    links: unknown[]
  ): { decision: SamplingDecision }
  toString(): string
}

const DECISION_NOT_RECORD: SamplingDecision = 0
const DECISION_RECORD_AND_SAMPLED: SamplingDecision = 2

function traceIdRatioSample(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true
  if (ratio <= 0) return false
  const head = parseInt(traceId.slice(0, 8), 16)
  return head / 0xffffffff < ratio
}

function createParentBasedRatioSampler(ratio: number): Sampler {
  return {
    shouldSample(parentContext, traceId) {
      const parentSpan = trace.getSpan(parentContext as Context)
      if (parentSpan) {
        const sampled =
          (parentSpan.spanContext().traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
        return { decision: sampled ? DECISION_RECORD_AND_SAMPLED : DECISION_NOT_RECORD }
      }
      return {
        decision: traceIdRatioSample(traceId, ratio)
          ? DECISION_RECORD_AND_SAMPLED
          : DECISION_NOT_RECORD,
      }
    },
    toString() {
      return `ParentBased(${ratio})`
    },
  }
}

export interface TracerConfig {
  serviceName: string
  serviceVersion?: string
  environment?: string
  otlpEndpoint?: string
  samplingRatio?: number
  serviceInstanceId?: string
  credentials?: ChannelCredentials
}

/**
 * Initialize the tracer provider with OTLP export and W3C propagation.
 * No-op if already initialized or if no OTLP endpoint is available.
 */
export function initTracer(config: TracerConfig): void {
  if (tracerProvider) return

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

  const otlpEndpoint = config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  if (!otlpEndpoint) {
    console.warn(
      `[${config.serviceName}] [telemetry] tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set`
    )
    return
  }

  const resource = buildResource({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    serviceInstanceId: config.serviceInstanceId,
  })

  const samplingRatio =
    config.samplingRatio ??
    (process.env.OTEL_TRACES_SAMPLER_ARG ? Number(process.env.OTEL_TRACES_SAMPLER_ARG) : undefined)

  const effectiveEnv = config.environment ?? process.env.NODE_ENV
  const sampler =
    typeof samplingRatio === 'number' && Number.isFinite(samplingRatio)
      ? createParentBasedRatioSampler(Math.min(Math.max(samplingRatio, 0), 1))
      : effectiveEnv === 'production'
        ? createParentBasedRatioSampler(0.01)
        : undefined

  const exporter = new OTLPTraceExporter({
    url: otlpEndpoint,
    timeoutMillis: EXPORT_TIMEOUT_MS,
    ...(config.credentials ? { credentials: config.credentials } : {}),
  })

  tracerProvider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: MAX_QUEUE_SIZE,
        maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
        scheduledDelayMillis: SCHEDULED_DELAY_MS,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  })
  tracerProvider.register()
}

/**
 * Get a named tracer instance from the global tracer provider.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name)
}

/**
 * Gracefully shut down the tracer provider, flushing any pending spans.
 */
export async function shutdownTracer(): Promise<void> {
  if (!tracerProvider) return
  await tracerProvider.shutdown()
  tracerProvider = null
}
