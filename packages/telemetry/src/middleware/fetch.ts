/**
 * @catalyst/telemetry — Instrumented fetch wrapper
 *
 * Wraps the global `fetch` with `http.client.request.duration` histogram
 * recording, following stable OTEL HTTP client semantic conventions.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 */

import type { Meter } from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import { DURATION_BUCKETS } from '../constants.js'

const METRIC_HTTP_CLIENT_REQUEST_DURATION = 'http.client.request.duration'

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

export interface InstrumentedFetchOptions {
  /** Override server address (hostname). If omitted, parsed from each request URL. */
  serverAddress?: string
  /** Override server port. If omitted, parsed from each request URL (omitted if default). */
  serverPort?: number
}

/**
 * Creates a `fetch`-compatible function that records `http.client.request.duration`
 * for every outbound HTTP call.
 */
export function createInstrumentedFetch(
  meter: Meter,
  options?: InstrumentedFetchOptions
): typeof fetch {
  const histogram = meter.createHistogram(METRIC_HTTP_CLIENT_REQUEST_DURATION, {
    description: 'Duration of outbound HTTP requests',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  })

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startTime = performance.now()

    // Extract method
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')

    // Extract URL parts
    let url: URL
    if (input instanceof URL) {
      url = input
    } else if (input instanceof Request) {
      url = new URL(input.url)
    } else {
      url = new URL(input)
    }

    const serverAddress = options?.serverAddress ?? url.hostname
    const parsedPort = url.port ? parseInt(url.port, 10) : undefined
    const isDefaultPort = parsedPort === undefined || parsedPort === DEFAULT_PORTS[url.protocol]
    const serverPort = options?.serverPort ?? (isDefaultPort ? undefined : parsedPort)
    const scheme = url.protocol === 'https:' ? 'https' : 'http'

    const attrs: Record<string, string | number> = {
      [ATTR_HTTP_REQUEST_METHOD]: method.toUpperCase(),
      [ATTR_SERVER_ADDRESS]: serverAddress,
      [ATTR_URL_SCHEME]: scheme,
    }
    if (serverPort !== undefined) {
      attrs[ATTR_SERVER_PORT] = serverPort
    }

    try {
      const response = await fetch(input, init)

      attrs[ATTR_HTTP_RESPONSE_STATUS_CODE] = response.status
      if (response.status >= 400) {
        attrs[ATTR_ERROR_TYPE] = String(response.status)
      }

      const durationSeconds = (performance.now() - startTime) / 1000
      histogram.record(durationSeconds, attrs)

      return response
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : 'Error'
      attrs[ATTR_ERROR_TYPE] = errorType

      const durationSeconds = (performance.now() - startTime) / 1000
      histogram.record(durationSeconds, attrs)

      throw err
    }
  }
}
