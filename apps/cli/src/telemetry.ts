/**
 * CLI telemetry — initializes OTel tracing, structured logging, and RPC
 * instrumentation for the Catalyst CLI.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans and logs are exported
 * to the configured collector. Otherwise everything is noop — the CLI
 * works identically to before.
 */
import { TelemetryBuilder, shutdownTelemetry } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'

let _telemetry: ServiceTelemetry | undefined

/**
 * Initialize CLI telemetry. Safe to call multiple times — subsequent
 * calls return the existing instance.
 */
export async function initCliTelemetry(): Promise<ServiceTelemetry> {
  if (_telemetry) return _telemetry

  try {
    _telemetry = await new TelemetryBuilder('cli')
      .withLogger({ category: ['catalyst', 'cli'] })
      .withTracing()
      .withRpcInstrumentation()
      .build()
  } catch {
    _telemetry = TelemetryBuilder.noop('cli')
  }

  // Graceful shutdown on exit
  const cleanup = async () => {
    await shutdownTelemetry()
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  return _telemetry
}

/**
 * Get the current telemetry instance. Returns noop if not yet initialized.
 */
export function getCliTelemetry(): ServiceTelemetry {
  if (!_telemetry) {
    _telemetry = TelemetryBuilder.noop('cli')
  }
  return _telemetry
}
