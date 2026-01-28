/**
 * @catalyst/telemetry — TracerProvider setup
 *
 * Initializes OpenTelemetry tracing with OTLP HTTP export,
 * W3C Trace Context propagation, and BatchSpanProcessor.
 */

import { trace, propagation } from '@opentelemetry/api'
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import type { SpanExporter } from '@opentelemetry/sdk-trace-node'
import { buildResource } from './resource'

interface TracerOptions {
  serviceName: string
  serviceVersion?: string
  environment?: string
  otlpEndpoint?: string
  batch?: {
    maxQueueSize?: number
    maxExportBatchSize?: number
    scheduledDelayMillis?: number
  }
  /** @internal Test-only: inject an in-memory exporter */
  _testExporter?: SpanExporter
}

let provider: NodeTracerProvider | null = null

export function initTracer(opts: TracerOptions): void {
  if (provider) {
    console.warn(
      '[telemetry] TracerProvider already initialized, ignoring duplicate initTracer call'
    )
    return
  }

  const resource = buildResource(opts)

  const spanProcessor = opts._testExporter
    ? new SimpleSpanProcessor(opts._testExporter)
    : new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/traces`,
          /**
           * WHY 5s timeout: The OTEL SDK default is 10s. A stalled collector
           * delays shutdown by 10s+ per flush attempt. 5s is a reasonable
           * balance between reliability and bounded shutdown time.
           */
          timeoutMillis: 5000,
        }),
        {
          maxQueueSize: opts.batch?.maxQueueSize ?? 2048,
          maxExportBatchSize: opts.batch?.maxExportBatchSize ?? 512,
          scheduledDelayMillis: opts.batch?.scheduledDelayMillis ?? 5000,
        }
      )

  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  })

  provider.register()

  // Set W3C Trace Context propagation globally
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
}

export function getTracer(name: string): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(name)
}

export async function shutdownTracer(): Promise<void> {
  if (!provider) return
  const p = provider
  provider = null
  await p.shutdown()
  trace.disable()
  propagation.disable()
}
