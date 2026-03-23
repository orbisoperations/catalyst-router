import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDashboardRoutes } from '../../src/routes/dashboard.js'
import type { DashboardOptions } from '../../src/routes/dashboard.js'

function makeOptions(overrides: Partial<DashboardOptions> = {}): DashboardOptions {
  return {
    orchestratorUrl: 'http://orchestrator:3000',
    otelServiceName: 'test-orchestrator',
    ...overrides,
  }
}

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET /state', () => {
    it('fetches state from orchestrator and returns it with lastUpdated', async () => {
      const mockState = { routes: { local: [], internal: [] }, peers: [] }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(mockState), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      const app = createDashboardRoutes(makeOptions())
      const res = await app.request('/state')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toEqual(mockState)
      expect(body.lastUpdated).toBeDefined()
      expect(body.stale).toBeUndefined()
    })

    it('returns cached state marked as stale when orchestrator is unreachable', async () => {
      const mockState = { routes: { local: [], internal: [] }, peers: [] }
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      // First call succeeds (populates cache)
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockState), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      const app = createDashboardRoutes(makeOptions())
      await app.request('/state')

      // Second call fails (orchestrator down)
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'))
      const res = await app.request('/state')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toEqual(mockState)
      expect(body.stale).toBe(true)
      expect(body.lastUpdated).toBeDefined()
    })

    it('returns 502 when orchestrator unreachable and no cache', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'))
      const app = createDashboardRoutes(makeOptions())
      const res = await app.request('/state')
      expect(res.status).toBe(502)
    })
  })

  describe('GET /services', () => {
    it('returns health check results', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }))
      const app = createDashboardRoutes(makeOptions())
      const res = await app.request('/services')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.groups).toBeDefined()
      const controlPlane = body.groups.find((g: { name: string }) => g.name === 'Control Plane')
      expect(controlPlane).toBeDefined()
      expect(controlPlane.services.some((s: { name: string }) => s.name === 'orchestrator')).toBe(
        true
      )
    })

    it('includes optional services when env vars are set', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }))
      const app = createDashboardRoutes(
        makeOptions({
          envoyUrl: 'http://envoy:9901',
          authUrl: 'http://auth:5000',
          gatewayUrl: 'http://gateway:6000',
        })
      )
      const res = await app.request('/services')
      const body = await res.json()
      const dataPlane = body.groups.find((g: { name: string }) => g.name === 'Data Plane')
      expect(dataPlane).toBeDefined()
      const federation = body.groups.find((g: { name: string }) => g.name === 'Federation')
      expect(federation).toBeDefined()
    })
  })

  describe('GET /config', () => {
    it('returns dashboard links when configured', async () => {
      const app = createDashboardRoutes(
        makeOptions({
          dashboardLinks: { grafana: 'http://grafana/{service}' },
        })
      )
      const res = await app.request('/config')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.links).toEqual({ grafana: 'http://grafana/{service}' })
    })

    it('returns null links when not configured', async () => {
      const app = createDashboardRoutes(makeOptions())
      const res = await app.request('/config')
      const body = await res.json()
      expect(body.links).toBeNull()
    })
  })
})
