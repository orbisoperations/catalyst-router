import { Hono } from 'hono'

export interface DashboardOptions {
  /** URL of the orchestrator's /api/state endpoint. */
  orchestratorUrl: string
  /** OTEL service name for the orchestrator (for health check display). */
  otelServiceName: string
  /** Envoy health URL (optional). */
  envoyUrl?: string
  /** Auth health URL (optional). */
  authUrl?: string
  /** Gateway health URL (optional). */
  gatewayUrl?: string
  /** Dashboard link templates (optional). */
  dashboardLinks?: Record<string, string>
}

interface ServiceDef {
  name: string
  otelName: string
  url: string
}

interface ServiceHealth extends ServiceDef {
  status: 'up' | 'down' | 'unknown'
  durationMs?: number
  error?: string
}

interface ServiceGroup {
  name: string
  services: ServiceHealth[]
}

function deriveServiceGroups(
  options: DashboardOptions
): { name: string; services: ServiceDef[] }[] {
  const controlPlane: ServiceDef[] = [
    {
      name: 'orchestrator',
      otelName: options.otelServiceName,
      url: `${options.orchestratorUrl}/health`,
    },
  ]

  if (options.authUrl) {
    controlPlane.push({ name: 'auth', otelName: 'auth', url: `${options.authUrl}/health` })
  }

  const dataPlane: ServiceDef[] = []
  if (options.envoyUrl) {
    dataPlane.push({
      name: 'envoy-service',
      otelName: 'envoy-service',
      url: `${options.envoyUrl}/health`,
    })
  }

  const federation: ServiceDef[] = []
  if (options.gatewayUrl) {
    federation.push({ name: 'gateway', otelName: 'gateway', url: `${options.gatewayUrl}/health` })
  }

  return [
    { name: 'Control Plane', services: controlPlane },
    { name: 'Data Plane', services: dataPlane },
    { name: 'Federation', services: federation },
  ].filter((g) => g.services.length > 0)
}

async function checkHealth(service: ServiceDef): Promise<ServiceHealth> {
  const start = performance.now()
  try {
    const res = await fetch(service.url, { signal: AbortSignal.timeout(3000) })
    return {
      ...service,
      status: res.ok ? 'up' : 'down',
      durationMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      ...service,
      status: 'down',
      durationMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function createDashboardRoutes(options: DashboardOptions): Hono {
  const app = new Hono()
  const serviceGroups = deriveServiceGroups(options)
  let cachedState: unknown = null

  // GET /state — fetch from orchestrator, cache for resilience
  app.get('/state', async (c) => {
    const stateUrl = `${options.orchestratorUrl}/api/state`
    try {
      const res = await fetch(stateUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      const body = await res.json()
      cachedState = body
      return c.json(body)
    } catch {
      if (cachedState !== null) {
        return c.json(cachedState)
      }
      return c.json({ error: 'Orchestrator unreachable' }, 502)
    }
  })

  // GET /services — health check polling
  app.get('/services', async (c) => {
    const groups: ServiceGroup[] = await Promise.all(
      serviceGroups.map(async (group) => ({
        name: group.name,
        services: await Promise.all(group.services.map(checkHealth)),
      }))
    )
    return c.json({ groups })
  })

  // GET /config — dashboard link templates
  app.get('/config', (c) => {
    return c.json({ links: options.dashboardLinks ?? null })
  })

  return app
}
