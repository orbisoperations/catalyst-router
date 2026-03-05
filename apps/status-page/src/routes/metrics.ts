import { Hono } from 'hono'

export function createMetricsRoutes(prometheusUrl: string): Hono {
  const app = new Hono()

  // Proxy PromQL instant queries
  app.get('/query', async (c) => {
    const query = c.req.query('query')
    if (!query) return c.json({ error: 'query parameter required' }, 400)

    const url = new URL('/api/v1/query', prometheusUrl)
    url.searchParams.set('query', query)
    const time = c.req.query('time')
    if (time) url.searchParams.set('time', time)

    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Proxy PromQL range queries
  app.get('/query_range', async (c) => {
    const params = ['query', 'start', 'end', 'step']
    const url = new URL('/api/v1/query_range', prometheusUrl)
    for (const p of params) {
      const v = c.req.query(p)
      if (v) url.searchParams.set(p, v)
    }

    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Proxy label values (for autocomplete)
  app.get('/label/:name/values', async (c) => {
    const url = new URL(`/api/v1/label/${c.req.param('name')}/values`, prometheusUrl)
    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  return app
}
