import { Hono } from 'hono'

interface ServiceHealth {
  name: string
  url: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

const SERVICES = [
  { name: 'orchestrator-a', url: 'http://node-a:3000/health' },
  { name: 'orchestrator-b', url: 'http://node-b:3000/health' },
  { name: 'gateway-a', url: 'http://gateway-a:4000/health' },
  { name: 'gateway-b', url: 'http://gateway-b:4000/health' },
  { name: 'auth', url: 'http://auth:4020/health' },
  { name: 'envoy-service', url: 'http://envoy-service:3000/health' },
]

async function checkHealth(service: { name: string; url: string }): Promise<ServiceHealth> {
  const start = performance.now()
  try {
    const res = await fetch(service.url, { signal: AbortSignal.timeout(3000) })
    return {
      name: service.name,
      url: service.url,
      status: res.ok ? 'up' : 'down',
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      name: service.name,
      url: service.url,
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function createHealthRoutes(): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const results = await Promise.all(SERVICES.map(checkHealth))
    return c.json({ services: results })
  })

  return app
}
