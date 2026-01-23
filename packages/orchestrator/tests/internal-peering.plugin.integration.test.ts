import { describe, it, expect } from 'bun:test'
import type { PluginContext } from '../src/plugins/types.js'
import { RouteTable } from '../src/state/route-table.js'
import { InternalBGPPlugin } from '../src/plugins/implementations/Internal-bgp.js'
// import type { Action, ApplyActionResult } from '../src/rpc/schema/index.js';
// import type { AuthContext } from '../src/plugins/types.js';

describe('Internal Peering Integration', () => {
  it('InternalBGPPlugin should handle open:internal-as', async () => {
    const plugin = new InternalBGPPlugin()
    const context: PluginContext = {
      action: {
        resource: 'internalBGP',
        resourceAction: 'open',
        data: {
          peerInfo: { id: 'remote-1', as: 200, endpoint: 'http://remote-1:3000/rpc', domains: [] },
        },
      },
      state: new RouteTable(),
      results: [],
      authxContext: { userId: 'test', roles: [] },
    }

    const result = await plugin.apply(context)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('Plugin failed')

    // Verify peer was added
    expect(result.ctx.state.getPeers()).toHaveLength(1)
    expect(result.ctx.state.getPeers()[0].id).toBe('remote-1')
  })

  it('InternalBGPPlugin should handle close:internal-as and cleanup routes', async () => {
    const plugin = new InternalBGPPlugin()
    let state = new RouteTable()

    // Seed state with a peer and a route from that peer
    const peer = { id: 'remote-exit', as: 300, endpoint: 'ws://host', domains: [] }
    state = state.addPeer(peer).state

    state = state.addInternalRoute(
      {
        name: 'service-from-peer',
        endpoint: 'http://peer-endpoint',
        protocol: 'tcp',
      },
      'remote-exit'
    ).state

    // Ensure seeded correctly
    expect(state.getPeers()).toHaveLength(1)
    expect(state.getInternalRoutes()).toHaveLength(1)
    expect(state.getInternalRoutes()[0].sourcePeerId).toBe('remote-exit')

    const context: PluginContext = {
      action: {
        resource: 'internalBGP',
        resourceAction: 'close',
        data: {
          peerInfo: { id: 'remote-exit', as: 300, endpoint: 'ws://host' },
        },
      },
      state,
      results: [],
      authxContext: { userId: 'test', roles: [] },
    }

    const result = await plugin.apply(context)

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('Plugin failed')
    expect(result.ctx.state.getPeers()).toHaveLength(0)
    expect(result.ctx.state.getInternalRoutes()).toHaveLength(0)
  })
})
