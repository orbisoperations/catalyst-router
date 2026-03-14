import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import path from 'node:path'

const app = new Hono()

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000'
const PORT = parseInt(process.env.PORT ?? '3000', 10)
const frontendDir = process.env.FRONTEND_DIR ?? path.join(process.cwd(), 'frontend')

// Health endpoint
app.get('/health', (c) => c.json({ status: 'ok' }))

// Proxy /api/* to orchestrator's /dashboard/api/*
app.get('/api/*', async (c) => {
  const url = new URL(c.req.url)
  const subPath = url.pathname.replace(/^\/api/, '')
  const target = `${ORCHESTRATOR_URL}/dashboard/api${subPath}${url.search}`
  try {
    const res = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.text()
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    })
  } catch {
    return c.json({ error: 'Orchestrator unreachable' }, 502)
  }
})

// Serve static frontend files
app.use('/*', serveStatic({ root: frontendDir }))
// SPA fallback — serve index.html for all unmatched routes
app.get('/*', serveStatic({ root: frontendDir, path: 'index.html' }))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`web-ui listening on http://localhost:${info.port}`)
})
