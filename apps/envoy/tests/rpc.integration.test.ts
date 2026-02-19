import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createNodeWebSocket } from '@hono/node-ws'
import { serve } from '@hono/node-server'
import { newWebSocketRpcSession } from 'capnweb'
import type { UpdateResult } from '../src/rpc/server.js'
import { EnvoyRpcServer, createRpcHandler } from '../src/rpc/server.js'

describe('Envoy RPC Integration', () => {
  let server: ReturnType<typeof serve>
  let port: number

  beforeAll(() => {
    const rpcServer = new EnvoyRpcServer()
    const app = createRpcHandler(rpcServer)
    const { injectWebSocket } = createNodeWebSocket({ app })

    server = serve({
      fetch: app.fetch,
      port: 0, // Random port
    })
    injectWebSocket(server)
    port = (server.address() as { port: number }).port
  })

  afterAll(() => {
    if (server) server.close()
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
    it('accepts valid config with local routes', async () => {
      const { ws, rpc } = await connectClient()

      const config = {
        local: [
          {
            name: 'books-api',
            protocol: 'http',
            endpoint: 'http://localhost:8080',
            envoyPort: 9001,
          },
        ],
        internal: [],
      }

      const result: UpdateResult = await rpc.updateRoutes(config)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('accepts valid config with internal routes', async () => {
      const { ws, rpc } = await connectClient()

      const config = {
        local: [],
        internal: [
          {
            name: 'movies-api',
            protocol: 'http:graphql',
            endpoint: 'http://peer-node:8081/graphql',
            envoyPort: 9002,
            peer: { name: 'peer-node-1', envoyAddress: 'https://10.0.0.5:443' },
            peerName: 'peer-node-1',
            nodePath: ['local-node', 'peer-node-1'],
          },
        ],
      }

      const result: UpdateResult = await rpc.updateRoutes(config)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('accepts config with both local and internal routes', async () => {
      const { ws, rpc } = await connectClient()

      const config = {
        local: [
          {
            name: 'books-api',
            protocol: 'http',
            endpoint: 'http://localhost:8080',
            envoyPort: 9001,
          },
        ],
        internal: [
          {
            name: 'movies-api',
            protocol: 'http:graphql',
            endpoint: 'http://peer-node:8081/graphql',
            envoyPort: 9002,
            peer: { name: 'peer-node-1' },
            peerName: 'peer-node-1',
            nodePath: ['local-node', 'peer-node-1'],
          },
        ],
      }

      const result: UpdateResult = await rpc.updateRoutes(config)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('rejects malformed config (flat array instead of object)', async () => {
      const { ws, rpc } = await connectClient()

      const invalid = [{ name: 'books-api', protocol: 'http' }]

      const result: UpdateResult = await rpc.updateRoutes(invalid)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Malformed')
      }

      ws.close()
    })

    it('rejects config with invalid local route', async () => {
      const { ws, rpc } = await connectClient()

      const invalid = {
        local: [
          { name: 123, protocol: 'http' }, // name should be string
        ],
        internal: [],
      }

      const result: UpdateResult = await rpc.updateRoutes(invalid)
      expect(result.success).toBe(false)

      ws.close()
    })

    it('rejects config with invalid internal route (missing peer)', async () => {
      const { ws, rpc } = await connectClient()

      const invalid = {
        local: [],
        internal: [
          {
            name: 'movies-api',
            protocol: 'http',
            endpoint: 'http://peer-node:8081',
            envoyPort: 9002,
            // missing peer, peerName, nodePath
          },
        ],
      }

      const result: UpdateResult = await rpc.updateRoutes(invalid)
      expect(result.success).toBe(false)

      ws.close()
    })

    it('accepts empty local and internal arrays (clears config)', async () => {
      const { ws, rpc } = await connectClient()

      const config = { local: [], internal: [] }

      const result: UpdateResult = await rpc.updateRoutes(config)
      expect(result.success).toBe(true)

      ws.close()
    })

    it('stores config accessible via getRoutes', async () => {
      const { ws, rpc } = await connectClient()

      const config = {
        local: [
          {
            name: 'books-api',
            protocol: 'http',
            endpoint: 'http://localhost:8080',
            envoyPort: 9001,
          },
        ],
        internal: [],
      }

      await rpc.updateRoutes(config)
      const current = await rpc.getRoutes()

      expect(current.local).toEqual(config.local)
      expect(current.internal).toEqual(config.internal)

      ws.close()
    })

    it('replaces previous config on subsequent calls', async () => {
      const { ws, rpc } = await connectClient()

      const first = {
        local: [
          {
            name: 'books-api',
            protocol: 'http',
            endpoint: 'http://localhost:8080',
            envoyPort: 9001,
          },
        ],
        internal: [],
      }

      const second = {
        local: [],
        internal: [
          {
            name: 'movies-api',
            protocol: 'http:graphql',
            endpoint: 'http://peer-node:8081/graphql',
            envoyPort: 9002,
            peer: { name: 'peer-node-1' },
            peerName: 'peer-node-1',
            nodePath: ['local-node', 'peer-node-1'],
          },
        ],
      }

      await rpc.updateRoutes(first)
      await rpc.updateRoutes(second)

      const current = await rpc.getRoutes()
      expect(current.local).toEqual(second.local)
      expect(current.internal).toEqual(second.internal)

      ws.close()
    })
  })

  describe('getRoutes', () => {
    it('returns empty config when no routes configured', async () => {
      // Fresh RPC server for this test
      const freshRpc = new EnvoyRpcServer()
      const freshApp = createRpcHandler(freshRpc)
      const { injectWebSocket: freshInjectWs } = createNodeWebSocket({ app: freshApp })
      const freshServer = serve({
        fetch: freshApp.fetch,
        port: 0,
      })
      freshInjectWs(freshServer)
      const freshPort = (freshServer.address() as { port: number }).port

      const ws = new WebSocket(`ws://localhost:${freshPort}/`)
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
      const rpc = newWebSocketRpcSession(ws as unknown as WebSocket)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const routes = await (rpc as any).getRoutes()
      expect(routes).toEqual({ local: [], internal: [] })

      ws.close()
      freshServer.close()
    })
  })
})
