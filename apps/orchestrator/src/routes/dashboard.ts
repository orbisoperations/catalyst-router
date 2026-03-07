import { Hono } from 'hono'
import type { CatalystConfig } from '@catalyst/config'
import type { CatalystNodeBus } from '../orchestrator.js'

interface ServiceDef {
  name: string
  otelName: string
  url: string
}

interface ServiceHealth extends ServiceDef {
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

interface ServiceGroup {
  name: string
  services: ServiceHealth[]
}

/** Build an HTTP health URL from a WebSocket endpoint's host and port. */
function healthUrlFromWsEndpoint(wsEndpoint: string): string {
  const parsed = new URL(wsEndpoint)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = '/health'
  return parsed.toString()
}

/** Derive health-check targets from the orchestrator's existing config. */
function deriveServiceGroups(config: CatalystConfig): { name: string; services: ServiceDef[] }[] {
  const port = config.port ?? 3000
  const nodeId = config.node.name
  const otelName = process.env.OTEL_SERVICE_NAME ?? nodeId

  const controlPlane: ServiceDef[] = [
    { name: 'orchestrator', otelName, url: `http://localhost:${port}/health` },
  ]

  const authEndpoint = config.orchestrator?.auth?.endpoint ?? process.env.CATALYST_AUTH_ENDPOINT
  if (authEndpoint) {
    controlPlane.push({
      name: 'auth',
      otelName: 'auth',
      url: healthUrlFromWsEndpoint(authEndpoint),
    })
  }

  const dataPlane: ServiceDef[] = []
  if (config.orchestrator?.envoyConfig?.endpoint) {
    dataPlane.push({
      name: 'envoy-service',
      otelName: 'envoy-service',
      url: healthUrlFromWsEndpoint(config.orchestrator.envoyConfig.endpoint),
    })
  }

  const federation: ServiceDef[] = []
  if (config.orchestrator?.gqlGatewayConfig?.endpoint) {
    federation.push({
      name: 'gateway',
      otelName: 'gateway',
      url: healthUrlFromWsEndpoint(config.orchestrator.gqlGatewayConfig.endpoint),
    })
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
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      ...service,
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function createDashboardRoutes(bus: CatalystNodeBus, config: CatalystConfig): Hono {
  const app = new Hono()
  const serviceGroups = deriveServiceGroups(config)

  // GET /state — route table + peers from in-memory state
  app.get('/state', (c) => {
    const state = bus.getState()
    return c.json({
      routes: {
        local: state.local.routes,
        internal: state.internal.routes,
      },
      peers: state.internal.peers,
    })
  })

  // GET /services — health-check polling of sibling services
  app.get('/services', async (c) => {
    const groups: ServiceGroup[] = await Promise.all(
      serviceGroups.map(async (group) => ({
        name: group.name,
        services: await Promise.all(group.services.map(checkHealth)),
      }))
    )
    return c.json({ groups })
  })

  // GET /config — dashboard link templates for the frontend
  app.get('/config', (c) => {
    return c.json({ links: config.dashboard?.links ?? null })
  })

  return app
}
