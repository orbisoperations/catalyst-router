import { Hono } from 'hono'
import { OnReadyHookSchema, OnNotReadyHookSchema } from '../types.js'

interface HooksOptions {
  nodeName: string
  rtspPort: number
  onReady: (route: { name: string; protocol: string; endpoint: string }) => Promise<void>
  onNotReady: (route: { name: string; protocol: string }) => Promise<void>
}

export function createHooksRouter(options: HooksOptions): Hono {
  const app = new Hono()

  app.post('/ready', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = OnReadyHookSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid hook payload' }, 400)
    }

    const name = `${options.nodeName}/${parsed.data.path}`

    const endpoint = `rtsp://localhost:${options.rtspPort}/${parsed.data.path}`

    try {
      await options.onReady({
        name,
        protocol: 'media',
        endpoint,
      })
      return c.json({ success: true })
    } catch (e) {
      return c.json({ success: false, error: String(e) }, 500)
    }
  })

  app.post('/not-ready', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = OnNotReadyHookSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid hook payload' }, 400)
    }

    const name = `${options.nodeName}/${parsed.data.path}`

    try {
      await options.onNotReady({
        name,
        protocol: 'media',
      })
      return c.json({ success: true })
    } catch (e) {
      return c.json({ success: false, error: String(e) }, 500)
    }
  })

  return app
}
