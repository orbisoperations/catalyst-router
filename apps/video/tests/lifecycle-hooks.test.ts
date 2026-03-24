import { describe, expect, it, vi } from 'vitest'
import { createLifecycleHooks } from '../src/hooks/lifecycle.js'
import type { StreamRouteManager } from '../src/routes/stream-route-manager.js'
import { SessionRegistry } from '../src/session/session-registry.js'

function makeRouteManager(): StreamRouteManager {
  return {
    handleReady: vi.fn().mockResolvedValue(undefined),
    handleNotReady: vi.fn().mockResolvedValue(undefined),
    streamCount: 0,
    shutdown: vi.fn(),
  } as unknown as StreamRouteManager
}

function makeHook(routeManager?: StreamRouteManager) {
  const manager = routeManager ?? makeRouteManager()
  const app = createLifecycleHooks({ routeManager: manager })
  return { app, manager }
}

function hookPayload(overrides: Record<string, unknown> = {}) {
  return {
    path: 'cam-front',
    sourceType: 'rtspSession',
    sourceId: 'conn-12345',
    ...overrides,
  }
}

describe('Lifecycle Hooks', () => {
  describe('POST /video-stream/hooks/ready', () => {
    it('registers a route on valid ready event', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.route).toBe('cam-front')
      expect(manager.handleReady).toHaveBeenCalledWith('cam-front', {
        sourceType: 'rtspSession',
        sourceId: 'conn-12345',
      })
    })

    it('rejects invalid path (shell injection attempt)', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '../../../etc/passwd' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with spaces', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: 'cam front' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects malformed JSON', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })

    it('returns 500 when route manager throws', async () => {
      const manager = makeRouteManager()
      ;(manager.handleReady as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC error'))
      const { app } = makeHook(manager)
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toContain('RPC error')
    })

    it('rejects non-localhost with x-forwarded-for header', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '192.168.1.100',
        },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(403)
      expect(manager.handleReady).not.toHaveBeenCalled()
    })

    it('rejects non-localhost via x-real-ip header', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': '10.0.0.5',
        },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(403)
      expect(manager.handleReady).not.toHaveBeenCalled()
    })

    it('rejects path with backticks', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '`whoami`' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with dollar sign', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '$HOME' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty path', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing path field', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'rtspSession', sourceId: 'c1' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing sourceType field', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front', sourceId: 'c1' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing sourceId field', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front', sourceType: 'rtspSession' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty body', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('accepts path matching safe pattern with dots, hyphens, underscores', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: 'Cam_01.front-view' })),
      })
      expect(res.status).toBe(200)
    })

    it('rejects path with pipe character', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: 'cam|cat /etc/passwd' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects path with newline', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: 'cam\nwhoami' })),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /video-stream/hooks/not-ready', () => {
    it('deregisters a route on valid not-ready event', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(manager.handleNotReady).toHaveBeenCalledWith('cam-front')
    })

    it('rejects invalid payload', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam;rm -rf /' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects non-localhost', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '10.0.0.5',
        },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(403)
      expect(manager.handleNotReady).not.toHaveBeenCalled()
    })

    it('rejects non-localhost via x-real-ip header', async () => {
      const { app, manager } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': '192.168.1.50',
        },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(403)
      expect(manager.handleNotReady).not.toHaveBeenCalled()
    })

    it('returns 500 when route manager throws', async () => {
      const manager = makeRouteManager()
      ;(manager.handleNotReady as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC error')
      )
      const { app } = makeHook(manager)
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload()),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('rejects path with backticks', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '`whoami`' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty path', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hookPayload({ path: '' })),
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty body', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('rejects malformed JSON', async () => {
      const { app } = makeHook()
      const res = await app.request('/video-stream/hooks/not-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /video-stream/hooks/unread', () => {
    it('removes session from registry by readerId', async () => {
      const registry = new SessionRegistry()
      registry.add({ id: 'reader-abc', path: 'cam-front', protocol: 'rtsp', exp: Date.now() + 60000, recordedAt: Date.now() })

      const app = createLifecycleHooks({ routeManager: makeRouteManager(), sessionRegistry: registry })

      const res = await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front', readerId: 'reader-abc', readerType: 'rtspSession' }),
      })

      expect(res.status).toBe(200)
      expect(registry.get('reader-abc')).toBeUndefined()
    })

    it('returns 200 when registry is not provided', async () => {
      const app = createLifecycleHooks({ routeManager: makeRouteManager() })

      const res = await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'cam-front', readerId: 'reader-abc', readerType: 'rtspSession' }),
      })

      expect(res.status).toBe(200)
    })

    it('rejects invalid payload', async () => {
      const app = createLifecycleHooks({ routeManager: makeRouteManager(), sessionRegistry: new SessionRegistry() })

      const res = await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '../etc/passwd', readerId: 'x', readerType: 'y' }),
      })

      expect(res.status).toBe(400)
    })

    it('rejects non-localhost requests', async () => {
      const app = createLifecycleHooks({ routeManager: makeRouteManager(), sessionRegistry: new SessionRegistry() })

      const res = await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: JSON.stringify({ path: 'cam-front', readerId: 'reader-abc', readerType: 'rtspSession' }),
      })

      expect(res.status).toBe(403)
    })

    it('calls onLastSubscriberLeft when last session on a path is removed', async () => {
      const registry = new SessionRegistry()
      registry.add({ id: 'only-viewer', path: 'relay-cam', protocol: 'rtsp', exp: Date.now() + 60000, recordedAt: Date.now() })

      const onLastSub = vi.fn()
      const app = createLifecycleHooks({
        routeManager: makeRouteManager(),
        sessionRegistry: registry,
        onLastSubscriberLeft: onLastSub,
      })

      const res = await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'relay-cam', readerId: 'only-viewer', readerType: 'rtspSession' }),
      })

      expect(res.status).toBe(200)
      expect(registry.size).toBe(0)
      expect(onLastSub).toHaveBeenCalledWith('relay-cam')
    })

    it('does NOT call onLastSubscriberLeft when other sessions remain on the path', async () => {
      const registry = new SessionRegistry()
      registry.add({ id: 'viewer-1', path: 'relay-cam', protocol: 'rtsp', exp: Date.now() + 60000, recordedAt: Date.now() })
      registry.add({ id: 'viewer-2', path: 'relay-cam', protocol: 'rtsp', exp: Date.now() + 60000, recordedAt: Date.now() })

      const onLastSub = vi.fn()
      const app = createLifecycleHooks({
        routeManager: makeRouteManager(),
        sessionRegistry: registry,
        onLastSubscriberLeft: onLastSub,
      })

      await app.request('/video-stream/hooks/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'relay-cam', readerId: 'viewer-1', readerType: 'rtspSession' }),
      })

      expect(onLastSub).not.toHaveBeenCalled()
      expect(registry.size).toBe(1)
    })
  })
})
