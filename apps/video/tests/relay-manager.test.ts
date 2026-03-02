import { describe, it, expect, beforeEach } from 'vitest'
import { RelayManager } from '../src/relay/relay-manager.js'
import { MockMediaServerClient } from '../src/media/client.js'
import type { RemoteMediaRoute } from '../src/types.js'

describe('RelayManager', () => {
  let client: MockMediaServerClient
  let relay: RelayManager

  beforeEach(() => {
    client = new MockMediaServerClient()
    relay = new RelayManager(client)
  })

  it('adds missing pull paths for desired routes', async () => {
    const desired: RemoteMediaRoute[] = [
      {
        name: 'node-a/cam-front',
        endpoint: 'rtsp://node-a:8554/node-a/cam-front',
        protocol: 'media',
        tags: ['codec:h264'],
      },
    ]

    await relay.reconcile(desired)

    expect(client.paths.has('node-a/cam-front')).toBe(true)
    const config = client.paths.get('node-a/cam-front')
    expect(config?.source).toBe('rtsp://node-a:8554/node-a/cam-front')
    expect(config?.sourceOnDemand).toBe(true)
    expect(config?.sourceOnDemandCloseAfter).toBe('10s')
  })

  it('removes stale paths not in desired set', async () => {
    // Add initial route
    await relay.reconcile([
      {
        name: 'node-a/cam-front',
        endpoint: 'rtsp://node-a:8554/node-a/cam-front',
        protocol: 'media',
      },
    ])
    expect(client.paths.has('node-a/cam-front')).toBe(true)

    // Reconcile with empty set
    await relay.reconcile([])
    expect(client.paths.has('node-a/cam-front')).toBe(false)
  })

  it('is idempotent — duplicate add treated as success', async () => {
    const desired: RemoteMediaRoute[] = [
      {
        name: 'node-a/cam-front',
        endpoint: 'rtsp://node-a:8554/node-a/cam-front',
        protocol: 'media',
      },
    ]

    await relay.reconcile(desired)
    await relay.reconcile(desired)

    expect(client.paths.has('node-a/cam-front')).toBe(true)
    expect(client.paths.size).toBe(1)
  })

  it('handles multiple routes in a single reconcile', async () => {
    const desired: RemoteMediaRoute[] = [
      {
        name: 'node-a/cam-front',
        endpoint: 'rtsp://node-a:8554/node-a/cam-front',
        protocol: 'media',
      },
      {
        name: 'node-b/cam-rear',
        endpoint: 'rtsp://node-b:8554/node-b/cam-rear',
        protocol: 'media',
      },
    ]

    await relay.reconcile(desired)

    expect(client.paths.size).toBe(2)
    expect(client.paths.has('node-a/cam-front')).toBe(true)
    expect(client.paths.has('node-b/cam-rear')).toBe(true)
  })

  it('adds new routes and removes stale ones in same reconcile', async () => {
    await relay.reconcile([
      {
        name: 'node-a/cam-front',
        endpoint: 'rtsp://node-a:8554/node-a/cam-front',
        protocol: 'media',
      },
    ])

    await relay.reconcile([
      {
        name: 'node-b/cam-rear',
        endpoint: 'rtsp://node-b:8554/node-b/cam-rear',
        protocol: 'media',
      },
    ])

    expect(client.paths.has('node-a/cam-front')).toBe(false)
    expect(client.paths.has('node-b/cam-rear')).toBe(true)
    expect(client.paths.size).toBe(1)
  })
})
