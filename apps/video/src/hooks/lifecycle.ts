import { Hono } from 'hono'
import { MediaMtxHookPayloadSchema } from '../mediamtx/types.js'
import type { StreamRouteManager } from '../routes/stream-route-manager.js'

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export interface LifecycleHookOptions {
  routeManager: StreamRouteManager
}

/**
 * Lifecycle webhook handlers called by MediaMTX's runOnReady/runOnNotReady hooks.
 *
 * Both endpoints enforce localhost-only source IPs — without this check,
 * any network attacker could inject fake media routes by POSTing to the
 * hook endpoint.
 */
export function createLifecycleHooks(options: LifecycleHookOptions): Hono {
  const { routeManager } = options
  const app = new Hono()

  app.post('/video-stream/hooks/ready', async (c) => {
    const clientIp =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      '127.0.0.1'

    if (!LOCALHOST_IPS.has(clientIp)) {
      return c.json({ success: false, error: 'Hook calls must originate from localhost' }, 403)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = MediaMtxHookPayloadSchema.safeParse(body)

    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid hook payload', details: parsed.error.issues },
        400
      )
    }

    try {
      await routeManager.handleReady(parsed.data.path, {
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
      })
      return c.json({ success: true, route: parsed.data.path })
    } catch (err) {
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to register stream route',
        },
        500
      )
    }
  })

  app.post('/video-stream/hooks/not-ready', async (c) => {
    const clientIp =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      '127.0.0.1'

    if (!LOCALHOST_IPS.has(clientIp)) {
      return c.json({ success: false, error: 'Hook calls must originate from localhost' }, 403)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = MediaMtxHookPayloadSchema.safeParse(body)

    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid hook payload', details: parsed.error.issues },
        400
      )
    }

    try {
      await routeManager.handleNotReady(parsed.data.path)
      return c.json({ success: true })
    } catch (err) {
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to deregister stream route',
        },
        500
      )
    }
  })

  return app
}
