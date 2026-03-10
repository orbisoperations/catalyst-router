/**
 * createInstrumentedFetch unit tests
 *
 * Validates http.client.request.duration recording with OTEL semconv attributes.
 * Uses a spy meter — no global OTel state, safe for parallel execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Meter } from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import { createInstrumentedFetch } from '../src/middleware/fetch.js'

// ---------------------------------------------------------------------------
// Spy factory — builds a Meter with observable histogram
// ---------------------------------------------------------------------------

function createSpyMeter() {
  const histogramRecordSpy = vi.fn()
  const createHistogramSpy = vi.fn(() => ({ record: histogramRecordSpy }))

  const meter = {
    createCounter: vi.fn(() => ({ add: vi.fn() })),
    createHistogram: createHistogramSpy,
    createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    createObservableCounter: vi.fn(() => ({})),
    createObservableGauge: vi.fn(() => ({})),
    createObservableUpDownCounter: vi.fn(() => ({})),
    createGauge: vi.fn(() => ({})),
  } as unknown as Meter

  return { meter, createHistogramSpy, histogramRecordSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createInstrumentedFetch', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('creates an http.client.request.duration histogram', () => {
    const { meter, createHistogramSpy } = createSpyMeter()
    createInstrumentedFetch(meter)

    expect(createHistogramSpy).toHaveBeenCalledWith(
      'http.client.request.duration',
      expect.objectContaining({
        unit: 's',
        advice: expect.objectContaining({
          explicitBucketBoundaries: expect.any(Array),
        }),
      })
    )
  })

  describe('successful responses', () => {
    beforeEach(() => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('ok', { status: 200 }))
      ) as unknown as typeof fetch
    })

    it('records GET with semconv attributes', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
          [ATTR_SERVER_ADDRESS]: 'mediamtx',
          [ATTR_URL_SCHEME]: 'http',
        })
      )
    })

    it('records DELETE method from init', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/cam1', { method: 'DELETE' })

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_REQUEST_METHOD]: 'DELETE',
        })
      )
    })

    it('extracts method and URL from Request object', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      const req = new Request('http://mediamtx:9997/v3/paths', { method: 'POST' })
      await fetchFn(req)

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_REQUEST_METHOD]: 'POST',
          [ATTR_SERVER_ADDRESS]: 'mediamtx',
        })
      )
    })

    it('extracts URL from URL object', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn(new URL('http://mediamtx:9997/v3/paths'))

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_SERVER_ADDRESS]: 'mediamtx',
        })
      )
    })

    it('includes non-default port in attributes', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      const attrs = histogramRecordSpy.mock.calls[0][1]
      expect(attrs[ATTR_SERVER_PORT]).toBe(9997)
    })

    it('omits default port 80 for http', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx/v3/paths/list')

      const attrs = histogramRecordSpy.mock.calls[0][1]
      expect(attrs[ATTR_SERVER_PORT]).toBeUndefined()
    })

    it('omits default port 443 for https', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('https://mediamtx/v3/paths/list')

      const attrs = histogramRecordSpy.mock.calls[0][1]
      expect(attrs[ATTR_SERVER_PORT]).toBeUndefined()
      expect(attrs[ATTR_URL_SCHEME]).toBe('https')
    })

    it('uses option overrides for serverAddress and serverPort', async () => {
      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter, {
        serverAddress: 'custom-host',
        serverPort: 8080,
      })

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_SERVER_ADDRESS]: 'custom-host',
          [ATTR_SERVER_PORT]: 8080,
        })
      )
    })
  })

  describe('error responses (4xx/5xx)', () => {
    it('sets error.type for 5xx status', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('error', { status: 500 }))
      ) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500,
          [ATTR_ERROR_TYPE]: '500',
        })
      )
    })

    it('sets error.type for 4xx status', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('not found', { status: 404 }))
      ) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/cam1')

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 404,
          [ATTR_ERROR_TYPE]: '404',
        })
      )
    })

    it('does not set error.type for 3xx status', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(null, { status: 301 }))
      ) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      const attrs = histogramRecordSpy.mock.calls[0][1]
      expect(attrs[ATTR_ERROR_TYPE]).toBeUndefined()
    })
  })

  describe('network errors', () => {
    it('sets error.type to exception class name and re-throws', async () => {
      const networkError = new TypeError('fetch failed')
      globalThis.fetch = vi.fn(() => Promise.reject(networkError)) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await expect(fetchFn('http://mediamtx:9997/v3/paths/list')).rejects.toThrow(networkError)

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [ATTR_ERROR_TYPE]: 'TypeError',
        })
      )
    })

    it('uses "Error" for non-Error thrown values', async () => {
      globalThis.fetch = vi.fn(() => Promise.reject('string error')) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await expect(fetchFn('http://mediamtx:9997/v3/paths/list')).rejects.toBe('string error')

      expect(histogramRecordSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          [ATTR_ERROR_TYPE]: 'Error',
        })
      )
    })
  })

  describe('duration recording', () => {
    it('records a positive duration in seconds', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response('ok', { status: 200 }))
      ) as unknown as typeof fetch

      const { meter, histogramRecordSpy } = createSpyMeter()
      const fetchFn = createInstrumentedFetch(meter)

      await fetchFn('http://mediamtx:9997/v3/paths/list')

      const duration = histogramRecordSpy.mock.calls[0][0]
      expect(duration).toBeGreaterThan(0)
      expect(duration).toBeLessThan(1) // should be sub-second in tests
    })
  })
})
