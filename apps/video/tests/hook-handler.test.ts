import { describe, it, expect, beforeEach } from 'vitest'
import { createHooksRouter } from '../src/hooks/ready.js'

describe('Hooks Router', () => {
  let dispatched: { action: string; route: { name: string; protocol: string; endpoint?: string } }[]
  let router: ReturnType<typeof createHooksRouter>

  beforeEach(() => {
    dispatched = []
    router = createHooksRouter({
      nodeName: 'node-a.somebiz.local.io',
      rtspPort: 8554,
      onReady: async (route) => {
        dispatched.push({ action: 'create', route })
      },
      onNotReady: async (route) => {
        dispatched.push({ action: 'delete', route })
      },
    })
  })

  describe('POST /ready', () => {
    it('dispatches LocalRouteCreate with protocol media', async () => {
      const res = await router.request('/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front', sourceType: 'rtspSource' }),
      })

      expect(res.status).toBe(200)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].action).toBe('create')
      expect(dispatched[0].route.name).toBe('node-a.somebiz.local.io/cam-front')
      expect(dispatched[0].route.protocol).toBe('media')
      expect(dispatched[0].route.endpoint).toBe('rtsp://localhost:8554/cam-front')
    })

    it('prefixes path with node name', async () => {
      await router.request('/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-rear' }),
      })

      expect(dispatched[0].route.name).toBe('node-a.somebiz.local.io/cam-rear')
    })

    it('returns 400 for invalid payload', async () => {
      const res = await router.request('/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      expect(dispatched).toHaveLength(0)
    })
  })

  describe('POST /not-ready', () => {
    it('dispatches LocalRouteDelete', async () => {
      const res = await router.request('/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front' }),
      })

      expect(res.status).toBe(200)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].action).toBe('delete')
      expect(dispatched[0].route.name).toBe('node-a.somebiz.local.io/cam-front')
    })

    it('returns 400 for missing path', async () => {
      const res = await router.request('/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })
})
