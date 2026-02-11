import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { websocket } from 'hono/bun'
import { newWebSocketRpcSession } from 'capnweb'
import type { EnvoyUpdateResult } from '../src/rpc/server.js'
import { EnvoyRpcServer, createRpcHandler } from '../src/rpc/server.js'

describe('Envoy RPC Integration', () => {
  let server: ReturnType<typeof Bun.serve>
  let port: number

  beforeAll(() => {
    const rpcServer = new EnvoyRpcServer()
    const app = createRpcHandler(rpcServer)

    server = Bun.serve({
      fetch: app.fetch,
      websocket,
      port: 0, // Random port
    })
    port = server.port!
  })

  afterAll(() => {
    if (server) server.stop()
  })

  async function connectClient(): Promise<{
    ws: WebSocket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: any
  }> {
    const ws = new WebSocket(`ws://localhost:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(e))
    })
    const rpc = newWebSocketRpcSession(ws as unknown as WebSocket)
    return { ws, rpc }
  }

  describe('updateRoutes', () => {
    it('accepts valid routes with envoyPort', async () => {
      const { ws, rpc } = await connectClient()

      const routes = [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:8080',
          envoyPort: 9001,
        },
      ]

      const result: EnvoyUpdateResult = await rpc.updateRoutes(routes)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('accepts multiple routes', async () => {
      const { ws, rpc } = await connectClient()

      const routes = [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:8080',
          envoyPort: 9001,
        },
        {
          name: 'movies-api',
          protocol: 'http:graphql',
          endpoint: 'http://localhost:8081/graphql',
          envoyPort: 9002,
        },
      ]

      const result: EnvoyUpdateResult = await rpc.updateRoutes(routes)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('rejects malformed routes', async () => {
      const { ws, rpc } = await connectClient()

      const invalid = [
        { name: 123, protocol: 'http' }, // name should be string
      ]

      const result: EnvoyUpdateResult = await rpc.updateRoutes(invalid)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Malformed')
      }

      ws.close()
    })

    it('rejects routes with invalid protocol', async () => {
      const { ws, rpc } = await connectClient()

      const invalid = [
        {
          name: 'bad-service',
          protocol: 'tcp', // not a valid DataChannelProtocol
          endpoint: 'http://localhost:8080',
          envoyPort: 9001,
        },
      ]

      const result: EnvoyUpdateResult = await rpc.updateRoutes(invalid)
      expect(result.success).toBe(false)

      ws.close()
    })

    it('accepts empty routes array (clears config)', async () => {
      const { ws, rpc } = await connectClient()

      const result: EnvoyUpdateResult = await rpc.updateRoutes([])
      expect(result.success).toBe(true)

      ws.close()
    })

    it('stores routes accessible via getRoutes', async () => {
      const { ws, rpc } = await connectClient()

      const routes = [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:8080',
          envoyPort: 9001,
        },
      ]

      await rpc.updateRoutes(routes)
      const current = await rpc.getRoutes()

      expect(current).toEqual(routes)

      ws.close()
    })

    it('replaces previous routes on subsequent calls', async () => {
      const { ws, rpc } = await connectClient()

      const first = [
        {
          name: 'books-api',
          protocol: 'http',
          endpoint: 'http://localhost:8080',
          envoyPort: 9001,
        },
      ]

      const second = [
        {
          name: 'movies-api',
          protocol: 'http:graphql',
          endpoint: 'http://localhost:8081/graphql',
          envoyPort: 9002,
        },
      ]

      await rpc.updateRoutes(first)
      await rpc.updateRoutes(second)

      const current = await rpc.getRoutes()
      expect(current).toEqual(second)

      ws.close()
    })
  })

  describe('getRoutes', () => {
    it('returns empty array when no routes configured', async () => {
      // Fresh RPC server for this test
      const freshRpc = new EnvoyRpcServer()
      const freshApp = createRpcHandler(freshRpc)
      const freshServer = Bun.serve({
        fetch: freshApp.fetch,
        websocket,
        port: 0,
      })

      const ws = new WebSocket(`ws://localhost:${freshServer.port}/`)
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
      const rpc = newWebSocketRpcSession(ws as unknown as WebSocket)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const routes = await (rpc as any).getRoutes()
      expect(routes).toEqual([])

      ws.close()
      freshServer.stop()
    })
  })
})
