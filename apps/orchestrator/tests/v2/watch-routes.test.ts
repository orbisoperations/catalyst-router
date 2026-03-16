import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { createDataChannelClient, type TokenValidator } from '../../src/v2/rpc.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { Actions } from '@catalyst/routing/v2'
import type { RouteChange } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'

const config: OrchestratorConfig = {
  node: { name: 'node-a', endpoint: 'ws://node-a:4000', domains: ['example.local'] },
}

const route1 = { name: 'cam-1', protocol: 'media' as const, endpoint: 'rtsp://10.0.1.5:8554/cam-1' }
const route2 = { name: 'cam-2', protocol: 'media' as const, endpoint: 'rtsp://10.0.1.5:8554/cam-2' }

const allowAllValidator: TokenValidator = {
  validateToken: vi.fn().mockResolvedValue({ valid: true }),
}

describe('watchRoutes() subscription', () => {
  let transport: MockPeerTransport
  let bus: OrchestratorBus

  beforeEach(() => {
    transport = new MockPeerTransport()
    bus = new OrchestratorBus({ config, transport })
  })

  describe('bus.subscribeRouteChanges()', () => {
    it('subscriber receives route add deltas', async () => {
      const received: RouteChange[][] = []
      bus.subscribeRouteChanges((changes) => received.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })

      expect(received).toHaveLength(1)
      expect(received[0]).toHaveLength(1)
      expect(received[0]![0]!.type).toBe('added')
    })

    it('subscriber receives route remove deltas', async () => {
      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })

      const received: RouteChange[][] = []
      bus.subscribeRouteChanges((changes) => received.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteDelete, data: route1 })

      expect(received).toHaveLength(1)
      expect(received[0]![0]!.type).toBe('removed')
    })

    it('multiple subscribers all receive same deltas', async () => {
      const received1: RouteChange[][] = []
      const received2: RouteChange[][] = []
      bus.subscribeRouteChanges((changes) => received1.push(changes))
      bus.subscribeRouteChanges((changes) => received2.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })

      expect(received1).toHaveLength(1)
      expect(received2).toHaveLength(1)
    })

    it('unsubscribe stops receiving deltas', async () => {
      const received: RouteChange[][] = []
      const unsub = bus.subscribeRouteChanges((changes) => received.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })
      expect(received).toHaveLength(1)

      unsub()

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route2 })
      expect(received).toHaveLength(1) // no new entries
    })

    it('subscriber error does not block other subscribers', async () => {
      const received: RouteChange[][] = []
      bus.subscribeRouteChanges(() => {
        throw new Error('boom')
      })
      bus.subscribeRouteChanges((changes) => received.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })

      expect(received).toHaveLength(1)
    })

    it('no notification when commit has zero route changes', async () => {
      const received: RouteChange[][] = []
      bus.subscribeRouteChanges((changes) => received.push(changes))

      // Duplicate add — second one should not produce route changes
      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })
      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })

      expect(received).toHaveLength(1) // only first add
    })
  })

  describe('DataChannel.watchRoutes()', () => {
    it('subscribes and unsubscribes via the RPC interface', async () => {
      const result = await createDataChannelClient(bus, 'test-token', allowAllValidator)
      if (!result.success) throw new Error(result.error)
      const client = result.client

      const received: RouteChange[][] = []
      const unsub = client.watchRoutes((changes) => received.push(changes))

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route1 })
      expect(received).toHaveLength(1)

      unsub()

      await bus.dispatch({ action: Actions.LocalRouteCreate, data: route2 })
      expect(received).toHaveLength(1) // no new entries after unsub
    })
  })
})
