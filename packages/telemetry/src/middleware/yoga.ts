/**
 * @catalyst/telemetry — GraphQL Yoga telemetry plugin
 *
 * Convenience wrapper around @envelop/opentelemetry that provides
 * per-phase tracing (parse, validate, execute) and optional resolver tracing
 * for GraphQL Yoga servers.
 *
 * WHY: Every Catalyst service using Yoga needs the same OTEL plugin config.
 * This wrapper centralizes defaults (resolvers on, variables off, document off)
 * so services get consistent GraphQL tracing without boilerplate.
 *
 * WHY @envelop/opentelemetry over @graphql-hive/plugin-opentelemetry:
 * The Hive plugin depends on @graphql-hive/gateway-runtime, pulling in the
 * entire Hive Gateway SDK. The Envelop plugin is lightweight and works with
 * any Envelop-based server (Yoga uses Envelop internally).
 *
 * @see https://the-guild.dev/graphql/envelop/plugins/use-open-telemetry
 * @see https://the-guild.dev/graphql/yoga-server/docs/features/monitoring
 */

import { useOpenTelemetry, type TracingOptions } from '@envelop/opentelemetry'
import { trace } from '@opentelemetry/api'

export interface YogaTelemetryOptions {
  /**
   * Trace individual resolver calls (default: true).
   *
   * WHY enabled by default: Resolver-level spans reveal N+1 queries
   * and slow field resolution that are invisible at the operation level.
   */
  resolvers?: boolean

  /**
   * Include GraphQL variables in span attributes (default: false).
   *
   * WHY disabled by default: Variables may contain PII (user IDs,
   * emails, tokens). Enable only in non-production environments.
   */
  variables?: boolean

  /**
   * Include the GraphQL result in span attributes (default: false).
   *
   * WHY disabled by default: Response payloads can be large and may
   * contain sensitive data. Enable only for debugging.
   */
  result?: boolean

  /**
   * Include the GraphQL document (query string) in span attributes (default: false).
   *
   * WHY disabled by default: Query strings are high-cardinality and
   * inflate trace storage. Operation name is typically sufficient.
   */
  document?: boolean
}

/**
 * Create a Yoga-compatible telemetry plugin with sensible defaults.
 *
 * WHY this must be called after `initTelemetry()`: The underlying
 * `@envelop/opentelemetry` plugin eagerly captures the TracerProvider
 * and creates a Tracer at plugin construction time (not lazily per-request).
 * If no real provider is registered yet, the plugin binds to the OTEL
 * no-op provider and will never emit spans. Additionally, omitting the
 * provider argument causes the library to create AND globally register
 * a `BasicTracerProvider` with `ConsoleSpanExporter`, which would
 * overwrite your application's configured provider.
 *
 * Usage:
 * ```ts
 * import { initTelemetry } from '@catalyst/telemetry'
 * import { createYogaTelemetryPlugin } from '@catalyst/telemetry/middleware/yoga'
 *
 * await initTelemetry({ serviceName: 'my-service' })
 *
 * const yoga = createYoga({
 *   schema,
 *   plugins: [createYogaTelemetryPlugin()],
 * })
 * ```
 */
export function createYogaTelemetryPlugin(options?: YogaTelemetryOptions): ReturnType<typeof useOpenTelemetry> {
  const tracingOptions: TracingOptions = {
    resolvers: options?.resolvers ?? true,
    variables: options?.variables ?? false,
    result: options?.result ?? false,
    document: options?.document ?? false,
  }

  /**
   * WHY we pass the global TracerProvider explicitly: Without it,
   * @envelop/opentelemetry creates its own internal ConsoleSpanExporter,
   * bypassing whatever provider the application registered globally.
   * Passing trace.getTracerProvider() ensures spans flow through the
   * application's configured pipeline (e.g. OTLP exporter, BatchProcessor).
   */
  return useOpenTelemetry(tracingOptions, trace.getTracerProvider())
}
