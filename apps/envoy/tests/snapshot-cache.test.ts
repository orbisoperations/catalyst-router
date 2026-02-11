import { describe, it, expect, mock } from 'bun:test'
import { createSnapshotCache } from '../src/xds/snapshot-cache.js'
import type { XdsSnapshot } from '../src/xds/snapshot-cache.js'
import { buildIngressListener, buildLocalCluster } from '../src/xds/resources.js'

function makeSnapshot(version: string): XdsSnapshot {
  return { version, listeners: [], clusters: [] }
}

describe('SnapshotCache', () => {
  describe('getSnapshot', () => {
    it('returns undefined when no snapshot has been set', () => {
      const cache = createSnapshotCache()
      expect(cache.getSnapshot()).toBeUndefined()
    })

    it('returns the current snapshot after setSnapshot', () => {
      const cache = createSnapshotCache()
      const snapshot = makeSnapshot('1')
      cache.setSnapshot(snapshot)
      expect(cache.getSnapshot()).toEqual(snapshot)
    })

    it('returns the latest snapshot after multiple sets', () => {
      const cache = createSnapshotCache()
      cache.setSnapshot(makeSnapshot('1'))
      cache.setSnapshot(makeSnapshot('2'))
      expect(cache.getSnapshot()?.version).toBe('2')
    })
  })

  describe('setSnapshot', () => {
    it('replaces the previous snapshot', () => {
      const cache = createSnapshotCache()
      const first = makeSnapshot('1')
      const second = makeSnapshot('2')
      cache.setSnapshot(first)
      cache.setSnapshot(second)
      expect(cache.getSnapshot()).toEqual(second)
    })

    it('notifies watchers on set', () => {
      const cache = createSnapshotCache()
      const callback = mock(() => {})
      cache.watch(callback)

      const snapshot = makeSnapshot('1')
      cache.setSnapshot(snapshot)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(snapshot)
    })

    it('notifies multiple watchers', () => {
      const cache = createSnapshotCache()
      const cb1 = mock(() => {})
      const cb2 = mock(() => {})
      cache.watch(cb1)
      cache.watch(cb2)

      cache.setSnapshot(makeSnapshot('1'))

      expect(cb1).toHaveBeenCalledTimes(1)
      expect(cb2).toHaveBeenCalledTimes(1)
    })
  })

  describe('watch', () => {
    it('returns an unsubscribe function', () => {
      const cache = createSnapshotCache()
      const unwatch = cache.watch(() => {})
      expect(unwatch).toBeFunction()
    })

    it('stops notifying after unsubscribe', () => {
      const cache = createSnapshotCache()
      const callback = mock(() => {})
      const unwatch = cache.watch(callback)

      cache.setSnapshot(makeSnapshot('1'))
      expect(callback).toHaveBeenCalledTimes(1)

      unwatch()
      cache.setSnapshot(makeSnapshot('2'))
      expect(callback).toHaveBeenCalledTimes(1) // not called again
    })

    it('unsubscribing one watcher does not affect others', () => {
      const cache = createSnapshotCache()
      const cb1 = mock(() => {})
      const cb2 = mock(() => {})
      const unwatch1 = cache.watch(cb1)
      cache.watch(cb2)

      unwatch1()
      cache.setSnapshot(makeSnapshot('1'))

      expect(cb1).toHaveBeenCalledTimes(0)
      expect(cb2).toHaveBeenCalledTimes(1)
    })

    it('double unsubscribe is a no-op', () => {
      const cache = createSnapshotCache()
      const callback = mock(() => {})
      const unwatch = cache.watch(callback)

      unwatch()
      unwatch() // should not throw

      cache.setSnapshot(makeSnapshot('1'))
      expect(callback).toHaveBeenCalledTimes(0)
    })
  })

  describe('snapshot contents', () => {
    it('stores listeners in the snapshot', () => {
      const cache = createSnapshotCache()
      const listener = buildIngressListener({
        channelName: 'books-api',
        port: 8001,
        bindAddress: '0.0.0.0',
      })
      const snapshot: XdsSnapshot = {
        version: '1',
        listeners: [listener],
        clusters: [],
      }
      cache.setSnapshot(snapshot)
      expect(cache.getSnapshot()?.listeners).toHaveLength(1)
      expect(cache.getSnapshot()?.listeners[0].name).toBe('ingress_books-api')
    })

    it('stores clusters in the snapshot', () => {
      const cache = createSnapshotCache()
      const cluster = buildLocalCluster({
        channelName: 'books-api',
        address: '127.0.0.1',
        port: 5001,
      })
      const snapshot: XdsSnapshot = {
        version: '1',
        listeners: [],
        clusters: [cluster],
      }
      cache.setSnapshot(snapshot)
      expect(cache.getSnapshot()?.clusters).toHaveLength(1)
      expect(cache.getSnapshot()?.clusters[0].name).toBe('local_books-api')
    })
  })
})
