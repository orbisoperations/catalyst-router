import { Hono } from 'hono'
import { z } from 'zod'

const LOCALHOST_IPS = ['127.0.0.1', '::1']

const MediaMTXAuthRequestSchema = z.object({
  ip: z.string(),
  user: z.string(),
  password: z.string(),
  path: z.string(),
  protocol: z.string(),
  id: z.string(),
  action: z.enum(['publish', 'read', 'playback', 'api', 'metrics']),
  query: z.string(),
})

interface AuthOptions {
  authFailPublish: 'open' | 'closed'
  authFailSubscribe: 'open' | 'closed'
}

export function createAuthRouter(options: AuthOptions): Hono {
  const app = new Hono()

  app.post('/auth', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = MediaMTXAuthRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.body(null, 401)
    }

    const { ip, action } = parsed.data

    if (action === 'publish') {
      // Publish: only allow from localhost — remote publish always rejected
      if (LOCALHOST_IPS.includes(ip)) {
        return c.body(null, 200)
      }
      return c.body(null, 401)
    }

    if (action === 'read' || action === 'playback') {
      // TODO: validate viewer JWT via auth service when available.
      // Until then, respect the fail-open/fail-closed setting.
      if (options.authFailSubscribe === 'closed') {
        return c.body(null, 401)
      }
      return c.body(null, 200)
    }

    // API and metrics actions: allow
    if (action === 'api' || action === 'metrics') {
      return c.body(null, 200)
    }

    return c.body(null, 401)
  })

  return app
}
