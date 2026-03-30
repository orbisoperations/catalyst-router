import { describe, it, expect } from 'vitest'
import { ConfigurableRoutePolicy } from '../../src/v2/route-policy.js'
import type { PeerRecord, InternalRoute } from '../../src/v2/state.js'

describe('ConfigurableRoutePolicy', () => {
  it('returns all routes (pass-through)', () => {
    const policy = new ConfigurableRoutePolicy()
    const peer = {
      name: 'peer-a',
      domains: [],
      connectionStatus: 'connected',
    } as unknown as PeerRecord
    const routes: InternalRoute[] = [
      {
        name: 'svc-1',
        protocol: 'http',
        peer: { name: 'origin', domains: [] },
        nodePath: ['origin'],
        originNode: 'origin',
      },
      {
        name: 'svc-2',
        protocol: 'tcp',
        peer: { name: 'origin', domains: [] },
        nodePath: ['origin'],
        originNode: 'origin',
      },
    ]
    expect(policy.canSend(peer, routes)).toEqual(routes)
    expect(policy.canSend(peer, routes)).toHaveLength(2)
  })

  it('returns empty array for empty routes', () => {
    const policy = new ConfigurableRoutePolicy()
    const peer = { name: 'peer-a', domains: [] } as unknown as PeerRecord
    expect(policy.canSend(peer, [])).toEqual([])
  })
})
