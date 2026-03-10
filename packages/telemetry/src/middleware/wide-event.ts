/**
 * @catalyst/telemetry — Wide-event Hono middleware
 *
 * Creates a WideEvent per HTTP request, enriches it with request context,
 * makes it available to handlers via `c.get('wideEvent')`, and emits it
 * on response completion.
 *
 * Designed to be used alongside the telemetry middleware (spans + metrics).
 */

import type { Context, MiddlewareHandler } from 'hono'
import { getLogger } from '@logtape/logtape'
import { WideEvent } from '../wide-event.js'

/** Hono Variables type for handlers that need access to the wide event. */
export type WideEventVariables = { wideEvent: WideEvent }

export interface WideEventMiddlewareOptions {
  /** Logger category. Defaults to ['catalyst', 'wide']. */
  category?: string[]
}

export function wideEventMiddleware(options?: WideEventMiddlewareOptions): MiddlewareHandler {
  const category = options?.category ?? ['catalyst', 'wide']

  return async (c: Context<{ Variables: WideEventVariables }>, next: () => Promise<void>) => {
    const logger = getLogger(category)
    const event = new WideEvent('http.request', logger)

    event.set({
      'http.request.method': c.req.method,
      'url.path': c.req.path,
    })

    c.set('wideEvent', event)

    try {
      await next()
      event.set('http.response.status_code', c.res.status)
      if (c.res.status >= 400) {
        event.set('catalyst.event.outcome', 'failure')
      }
    } catch (err) {
      event.setError(err)
      throw err
    } finally {
      event.emit()
    }
  }
}
