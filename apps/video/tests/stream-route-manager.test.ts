import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  StreamRouteManager,
  type RouteRegistrar,
  type PathMetadataProvider,
} from '../src/routes/stream-route-manager.js'

function makeRegistrar(): RouteRegistrar {
  return {
    addRoute: vi.fn().mockResolvedValue(undefined),
    removeRoute: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMetadata(tracks: string[] = ['H264', 'Opus']): PathMetadataProvider {
  return {
    getPathMetadata: vi.fn().mockResolvedValue({ tracks, sourceType: 'rtspSession' }),
  }
}

function makeManager(opts?: {
  registrar?: RouteRegistrar
  metadata?: PathMetadataProvider
  maxStreams?: number
  debounceMs?: number
}) {
  const registrar = opts?.registrar ?? makeRegistrar()
  const metadata = opts?.metadata ?? makeMetadata()
  const manager = new StreamRouteManager({
    registrar,
    metadataProvider: metadata,
    advertiseAddress: '10.0.1.5',
    rtspPort: 8554,
    maxStreams: opts?.maxStreams ?? 100,
    debounceMs: opts?.debounceMs ?? 10, // Short debounce for tests
  })
  return { manager, registrar, metadata }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StreamRouteManager', () => {
  describe('ready → route creation', () => {
    it('creates a route with correct endpoint and tags after debounce', async () => {
      const { manager, registrar } = makeManager()
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })

      expect(registrar.addRoute).toHaveBeenCalledWith({
        name: 'cam-front',
        protocol: 'media',
        endpoint: 'rtsp://10.0.1.5:8554/cam-front',
        tags: ['track:H264', 'track:Opus', 'source-type:rtspSession'],
      })
      expect(manager.streamCount).toBe(1)
    })

    it('is idempotent for already-active path', async () => {
      const { manager, registrar } = makeManager()
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })

      expect(registrar.addRoute).toHaveBeenCalledTimes(1)
      expect(manager.streamCount).toBe(1)
    })

    it('handles null metadata gracefully', async () => {
      const metadata: PathMetadataProvider = {
        getPathMetadata: vi.fn().mockResolvedValue(null),
      }
      const { manager, registrar } = makeManager({ metadata })
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })

      expect(registrar.addRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['source-type:rtspSession'],
        })
      )
    })
  })

  describe('not-ready → route removal', () => {
    it('removes an active route after debounce', async () => {
      const { manager, registrar } = makeManager()
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      await manager.handleNotReady('cam-front')

      expect(registrar.removeRoute).toHaveBeenCalledWith('cam-front')
      expect(manager.streamCount).toBe(0)
    })

    it('is no-op for non-active path', async () => {
      const { manager, registrar } = makeManager()
      await manager.handleNotReady('cam-does-not-exist')

      expect(registrar.removeRoute).not.toHaveBeenCalled()
    })
  })

  describe('debounce coalescing', () => {
    it('cancels pending not-ready when ready arrives', async () => {
      const { manager, registrar } = makeManager({ debounceMs: 50 })

      // Create the route first
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      expect(manager.streamCount).toBe(1)

      // Start not-ready (will debounce 50ms) — don't await, we'll cancel it
      manager.handleNotReady('cam-front').catch(() => {})

      // Immediately fire ready again — should cancel the not-ready
      // The ready itself is a no-op because the route is already active
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })

      // The not-ready timer was cancelled, so this never resolves via timer.
      // But we set it up as a pending action; since handleReady cancelled the timer
      // and the route is still active, handleNotReady's promise never fires.
      // Wait a bit to make sure the removal didn't happen.
      await new Promise((r) => setTimeout(r, 80))

      expect(registrar.removeRoute).not.toHaveBeenCalled()
      expect(manager.streamCount).toBe(1)
    })

    it('cancels pending ready when not-ready arrives', async () => {
      const { manager, registrar } = makeManager({ debounceMs: 50 })

      // Start ready (will debounce 50ms) — don't await, we'll cancel it
      manager
        .handleReady('cam-front', {
          sourceType: 'rtspSession',
          sourceId: 'c1',
        })
        .catch(() => {})

      // Immediately fire not-ready — should cancel the ready
      // not-ready is no-op because the route isn't active yet
      await manager.handleNotReady('cam-front')

      // Wait for the debounce window to pass
      await new Promise((r) => setTimeout(r, 80))

      // The ready was cancelled, so addRoute should not have been called
      expect(registrar.addRoute).not.toHaveBeenCalled()
      expect(manager.streamCount).toBe(0)
    })

    it('handles per-path independence', async () => {
      const { manager, registrar } = makeManager()

      await Promise.all([
        manager.handleReady('cam-1', { sourceType: 'rtspSession', sourceId: 'c1' }),
        manager.handleReady('cam-2', { sourceType: 'rtspSession', sourceId: 'c2' }),
      ])

      expect(registrar.addRoute).toHaveBeenCalledTimes(2)
      expect(manager.streamCount).toBe(2)

      await manager.handleNotReady('cam-1')
      expect(manager.streamCount).toBe(1)
    })
  })

  describe('max stream limit', () => {
    it('rejects new streams when limit is reached', async () => {
      const { manager } = makeManager({ maxStreams: 2 })

      await manager.handleReady('cam-1', { sourceType: 'rtspSession', sourceId: 'c1' })
      await manager.handleReady('cam-2', { sourceType: 'rtspSession', sourceId: 'c2' })

      await expect(
        manager.handleReady('cam-3', { sourceType: 'rtspSession', sourceId: 'c3' })
      ).rejects.toThrow('Max streams limit reached')
    })

    it('allows new streams after removal', async () => {
      const { manager } = makeManager({ maxStreams: 2 })

      await manager.handleReady('cam-1', { sourceType: 'rtspSession', sourceId: 'c1' })
      await manager.handleReady('cam-2', { sourceType: 'rtspSession', sourceId: 'c2' })
      await manager.handleNotReady('cam-1')

      await expect(
        manager.handleReady('cam-3', { sourceType: 'rtspSession', sourceId: 'c3' })
      ).resolves.toBeUndefined()
      expect(manager.streamCount).toBe(2)
    })
  })

  describe('error handling', () => {
    it('rejects handleReady when addRoute fails', async () => {
      const registrar = makeRegistrar()
      ;(registrar.addRoute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC unavailable')
      )
      const { manager } = makeManager({ registrar })

      await expect(
        manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      ).rejects.toThrow('RPC unavailable')
      expect(manager.streamCount).toBe(0)
    })

    it('rejects handleNotReady when removeRoute fails', async () => {
      const registrar = makeRegistrar()
      const { manager } = makeManager({ registrar })

      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      expect(manager.streamCount).toBe(1)

      ;(registrar.removeRoute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC unavailable')
      )

      await expect(manager.handleNotReady('cam-front')).rejects.toThrow('RPC unavailable')
    })

    it('handles metadata provider failure gracefully', async () => {
      const metadata: PathMetadataProvider = {
        getPathMetadata: vi.fn().mockRejectedValue(new Error('Control API down')),
      }
      const { manager } = makeManager({ metadata })

      await expect(
        manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })
      ).rejects.toThrow('Control API down')
    })
  })

  describe('tag generation', () => {
    it('includes source-type tag from different sourceType values', async () => {
      const { manager, registrar } = makeManager()
      await manager.handleReady('cam-front', { sourceType: 'rtmpConn', sourceId: 'c1' })

      expect(registrar.addRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['source-type:rtmpConn']),
        })
      )
    })

    it('includes empty tracks when metadata returns empty array', async () => {
      const metadata = makeMetadata([])
      const { manager, registrar } = makeManager({ metadata })
      await manager.handleReady('cam-front', { sourceType: 'rtspSession', sourceId: 'c1' })

      expect(registrar.addRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['source-type:rtspSession'],
        })
      )
    })
  })

  describe('shutdown', () => {
    it('cancels all pending timers', async () => {
      const { manager, registrar } = makeManager({ debounceMs: 500 })

      // Start a ready but don't await — it's debouncing
      manager.handleReady('cam-1', { sourceType: 'rtspSession', sourceId: 'c1' }).catch(() => {})

      manager.shutdown()

      // Wait past debounce window
      await new Promise((r) => setTimeout(r, 600))

      // The route should not have been created since we shut down
      expect(registrar.addRoute).not.toHaveBeenCalled()
    })
  })
})
