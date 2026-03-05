import { Hono } from 'hono'

export function createTracesRoutes(jaegerUrl: string): Hono {
  const app = new Hono()

  // List services
  app.get('/services', async (c) => {
    const res = await fetch(new URL('/api/services', jaegerUrl))
    return c.json(await res.json(), res.status as 200)
  })

  // Search traces
  app.get('/traces', async (c) => {
    const url = new URL('/api/traces', jaegerUrl)
    for (const [k, v] of Object.entries(c.req.query())) {
      url.searchParams.set(k, v as string)
    }
    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Get single trace
  app.get('/traces/:traceId', async (c) => {
    const res = await fetch(new URL(`/api/traces/${c.req.param('traceId')}`, jaegerUrl))
    return c.json(await res.json(), res.status as 200)
  })

  return app
}
