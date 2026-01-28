/**
 * @catalyst/telemetry — W3C Trace Context propagation helpers
 *
 * Convenience wrappers around @opentelemetry/api propagation for
 * injecting/extracting trace context in HTTP headers.
 */

import { context, propagation, trace } from '@opentelemetry/api'
import type { Context } from '@opentelemetry/api'

const INVALID_TRACE_ID = '00000000000000000000000000000000'
const INVALID_SPAN_ID = '0000000000000000'

/**
 * Inject trace context headers (traceparent, tracestate) into a carrier object.
 * Uses the active context if none is provided.
 */
export function injectTraceHeaders(
  ctx: Context | undefined,
  carrier: Record<string, string>
): void {
  propagation.inject(ctx ?? context.active(), carrier)
}

/**
 * Extract trace context from inbound headers.
 * Returns a Context that can be used with context.with() to propagate the trace.
 */
export function extractTraceContext(headers: Record<string, string>): Context {
  return propagation.extract(context.active(), headers)
}

/**
 * Get the trace ID of the currently active span.
 * Returns undefined if no span is active or the trace ID is invalid.
 */
export function getTraceId(): string | undefined {
  const span = trace.getActiveSpan()
  if (!span) return undefined
  const traceId = span.spanContext().traceId
  return traceId === INVALID_TRACE_ID ? undefined : traceId
}

/**
 * Get the span ID of the currently active span.
 * Returns undefined if no span is active or the span ID is invalid.
 */
export function getSpanId(): string | undefined {
  const span = trace.getActiveSpan()
  if (!span) return undefined
  const spanId = span.spanContext().spanId
  return spanId === INVALID_SPAN_ID ? undefined : spanId
}
