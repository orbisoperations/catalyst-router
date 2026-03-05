import { Hono } from 'hono'

export function createLogsRoutes(influxdbUrl: string): Hono {
  const app = new Hono()

  // Query logs via Flux
  app.post('/query', async (c) => {
    const body = await c.req.json()
    const token = process.env.INFLUXDB_TOKEN ?? 'catalyst-dev-token'

    const res = await fetch(new URL('/api/v2/query?org=catalyst', influxdbUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: body.query,
        type: 'flux',
      }),
    })

    const text = await res.text()
    return c.text(text, res.status as 200)
  })

  return app
}
