import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CatalystConfig } from '@catalyst/config'
import type { DashboardStateProvider } from '../../src/routes/dashboard.js'

import { createDashboardRoutes } from '../../src/routes/dashboard.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const defaultEnvoyConfig = {
  endpoint: 'ws://envoy:9000',
  portRange: [[10000, 10100]] as [number, number][],
}

function makeConfig(overrides: Partial<CatalystConfig> = {}): CatalystConfig {
  return {
    node: {
      name: 'test-node',
      domains: ['test.local'],
      endpoint: 'ws://test-node:4000',
    },
    port: 3000,
    orchestrator: {
      envoyConfig: defaultEnvoyConfig,
      ...(overrides.orchestrator ?? {}),
    },
    ...overrides,
  }
}

function makeStateProvider(
  stateOverrides: Partial<ReturnType<DashboardStateProvider['getState']>> = {}
): DashboardStateProvider {
  return {
    getState: () => ({
      local: { routes: [{ name: 'route-a', endpoint: 'http://a:8080' }] },
      internal: {
        peers: [
          { name: 'peer-1', endpoint: 'ws://peer-1:4000', peerToken: 'secret-1' },
          { name: 'peer-2', endpoint: 'ws://peer-2:4000', peerToken: 'secret-2' },
        ],
        routes: [
          {
            name: 'remote-route',
            endpoint: 'http://remote:8080',
            peer: { name: 'peer-1', peerToken: 'secret-peer-route' },
          },
          { name: 'direct-route', endpoint: 'http://direct:8080' },
        ],
      },
      ...stateOverrides,
    }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /state
  // -------------------------------------------------------------------------

  describe('GET /state', () => {
    it('returns local and internal routes', async () => {
      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/state')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.routes.local).toEqual([{ name: 'route-a', endpoint: 'http://a:8080' }])
      expect(body.routes.internal).toHaveLength(2)
    })

    it('strips peerToken from peers', async () => {
      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/state')
      const body = await res.json()

      for (const peer of body.peers) {
        expect(peer).not.toHaveProperty('peerToken')
      }
      expect(body.peers[0]).toEqual({ name: 'peer-1', endpoint: 'ws://peer-1:4000' })
      expect(body.peers[1]).toEqual({ name: 'peer-2', endpoint: 'ws://peer-2:4000' })
    })

    it('strips peerToken from internal routes that have a peer object', async () => {
      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/state')
      const body = await res.json()

      const routeWithPeer = body.routes.internal.find(
        (r: Record<string, unknown>) => r.name === 'remote-route'
      )
      expect(routeWithPeer.peer).toEqual({ name: 'peer-1' })
      expect(routeWithPeer.peer).not.toHaveProperty('peerToken')

      // Route without peer object should be unchanged
      const directRoute = body.routes.internal.find(
        (r: Record<string, unknown>) => r.name === 'direct-route'
      )
      expect(directRoute).toEqual({ name: 'direct-route', endpoint: 'http://direct:8080' })
    })
  })

  // -------------------------------------------------------------------------
  // GET /services
  // -------------------------------------------------------------------------

  describe('GET /services', () => {
    it('returns health check results with durationMs', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.groups).toBeDefined()
      expect(body.groups.length).toBeGreaterThanOrEqual(1)

      // The control plane group should always exist with the orchestrator
      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      expect(controlPlane).toBeDefined()

      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      expect(orchestratorService.status).toBe('up')
      expect(orchestratorService).toHaveProperty('durationMs')
      expect(typeof orchestratorService.durationMs).toBe('number')

      fetchSpy.mockRestore()
    })

    it('reports status down with error when fetch fails', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Connection refused'))

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      expect(res.status).toBe(200)

      const body = await res.json()
      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      expect(orchestratorService.status).toBe('down')
      expect(orchestratorService.error).toBe('Connection refused')
      expect(orchestratorService).toHaveProperty('durationMs')

      fetchSpy.mockRestore()
    })

    it('reports status down when fetch returns non-OK status', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('Internal Server Error', { status: 500 }))

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      expect(orchestratorService.status).toBe('down')
      expect(orchestratorService).not.toHaveProperty('error')

      fetchSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // GET /config
  // -------------------------------------------------------------------------

  describe('GET /config', () => {
    it('returns configured dashboard links', async () => {
      const config = makeConfig({
        dashboard: {
          links: {
            grafana: 'https://grafana.example.com/d/{service}',
            logs: 'https://logs.example.com/{service}',
          },
        },
      })
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/config')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.links).toEqual({
        grafana: 'https://grafana.example.com/d/{service}',
        logs: 'https://logs.example.com/{service}',
      })
    })

    it('returns null links when no dashboard links are configured', async () => {
      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/config')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.links).toBeNull()
    })

    it('returns null links when dashboard config exists but links is undefined', async () => {
      const config = makeConfig({ dashboard: {} })
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/config')
      const body = await res.json()
      expect(body.links).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // deriveServiceGroups (tested via GET /services)
  // -------------------------------------------------------------------------

  describe('deriveServiceGroups (via /services)', () => {
    it('includes envoy-service in data plane when envoyConfig is set', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const config = makeConfig({
        orchestrator: {
          envoyConfig: {
            endpoint: 'ws://envoy:9000',
            portRange: [[10000, 10100]],
          },
        },
      })
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const dataPlane = body.groups.find((g: { name: string }) => g.name === 'Data Plane')
      expect(dataPlane).toBeDefined()
      expect(dataPlane.services.some((s: { name: string }) => s.name === 'envoy-service')).toBe(
        true
      )

      fetchSpy.mockRestore()
    })

    it('includes auth in control plane when auth endpoint is in config', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const config = makeConfig({
        orchestrator: {
          envoyConfig: defaultEnvoyConfig,
          auth: {
            endpoint: 'ws://auth:5000',
            systemToken: 'test-token',
          },
        },
      })
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      expect(controlPlane.services.some((s: { name: string }) => s.name === 'auth')).toBe(true)

      fetchSpy.mockRestore()
    })

    it('includes auth via CATALYST_AUTH_ENDPOINT env fallback', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      // Set the env var before creating routes
      const original = process.env.CATALYST_AUTH_ENDPOINT
      process.env.CATALYST_AUTH_ENDPOINT = 'ws://auth-from-env:5000'

      const config = makeConfig() // no auth in config
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      expect(controlPlane.services.some((s: { name: string }) => s.name === 'auth')).toBe(true)

      // Restore
      if (original === undefined) {
        delete process.env.CATALYST_AUTH_ENDPOINT
      } else {
        process.env.CATALYST_AUTH_ENDPOINT = original
      }
      fetchSpy.mockRestore()
    })

    it('includes gateway in federation group when gqlGatewayConfig is set', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const config = makeConfig({
        orchestrator: {
          envoyConfig: defaultEnvoyConfig,
          gqlGatewayConfig: { endpoint: 'ws://gateway:6000' },
        },
      })
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const federation = body.groups.find((g: { name: string }) => g.name === 'Federation')
      expect(federation).toBeDefined()
      expect(federation.services.some((s: { name: string }) => s.name === 'gateway')).toBe(true)

      fetchSpy.mockRestore()
    })

    it('filters out empty groups (no federation when gateway not configured)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      // No gateway, no auth => Control Plane + Data Plane only
      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      // Should have Control Plane and Data Plane, but no Federation
      expect(body.groups).toHaveLength(2)
      expect(body.groups.map((g: { name: string }) => g.name)).toEqual([
        'Control Plane',
        'Data Plane',
      ])

      fetchSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // Env var capture at init time
  // -------------------------------------------------------------------------

  describe('OTEL_SERVICE_NAME env var capture', () => {
    it('uses OTEL_SERVICE_NAME when set before route creation', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const original = process.env.OTEL_SERVICE_NAME
      process.env.OTEL_SERVICE_NAME = 'my-custom-otel-name'

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      expect(orchestratorService.otelName).toBe('my-custom-otel-name')

      if (original === undefined) {
        delete process.env.OTEL_SERVICE_NAME
      } else {
        process.env.OTEL_SERVICE_NAME = original
      }
      fetchSpy.mockRestore()
    })

    it('captures env var at init time (changing it later has no effect)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const original = process.env.OTEL_SERVICE_NAME
      process.env.OTEL_SERVICE_NAME = 'captured-value'

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      // Change env var after route creation
      process.env.OTEL_SERVICE_NAME = 'changed-after-init'

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      // Should still have the value from init time, not the changed value
      expect(orchestratorService.otelName).toBe('captured-value')

      if (original === undefined) {
        delete process.env.OTEL_SERVICE_NAME
      } else {
        process.env.OTEL_SERVICE_NAME = original
      }
      fetchSpy.mockRestore()
    })

    it('falls back to config.node.name when OTEL_SERVICE_NAME is unset', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('OK', { status: 200 }))

      const original = process.env.OTEL_SERVICE_NAME
      delete process.env.OTEL_SERVICE_NAME

      const config = makeConfig()
      const bus = makeStateProvider()
      const app = createDashboardRoutes(bus, config)

      const res = await app.request('/services')
      const body = await res.json()

      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      const orchestratorService = controlPlane.services.find(
        (s: { name: string }) => s.name === 'orchestrator'
      )
      expect(orchestratorService.otelName).toBe('test-node')

      if (original === undefined) {
        delete process.env.OTEL_SERVICE_NAME
      } else {
        process.env.OTEL_SERVICE_NAME = original
      }
      fetchSpy.mockRestore()
    })
  })
})
