import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { websocket } from 'hono/bun'
import { newWebSocketRpcSession } from 'capnweb'
import type { GatewayUpdateResult } from '../src/rpc/server.js'
import { createRpcHandler, GatewayRpcServer } from '../src/rpc/server.js'

describe('RPC Integration', () => {
  let server: ReturnType<typeof Bun.serve>
  let port: number
  let ws: WebSocket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rpcClient: any

  // Mock callback
  const updateCallback = mock(async (_config: unknown): Promise<GatewayUpdateResult> => {
    return { success: true }
  })

  beforeAll(async () => {
    const rpcServer = new GatewayRpcServer(updateCallback)
    const app = createRpcHandler(rpcServer)

    server = Bun.serve({
      fetch: app.fetch,
      websocket, // Use Hono's websocket definition which includes Bun's handlers
      port: 0, // Random port
    })
    port = server.port!
  })

  afterAll(() => {
    if (server) server.stop()
  })

  it('should connect and update config successfully', async () => {
    // Connect client
    ws = new WebSocket(`ws://localhost:${port}/`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(e))
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcClient = newWebSocketRpcSession(ws as unknown as WebSocket) as any

    const config = {
      services: [{ name: 'test-service', url: 'http://localhost:8080/graphql' }],
    }

    const result = await rpcClient.updateConfig(config)

    expect(result).toEqual({ success: true })
    expect(updateCallback).toHaveBeenCalled()
    expect(updateCallback).toHaveBeenCalledWith(config)

    ws.close()
  })

  it('should handle invalid configSchema', async () => {
    updateCallback.mockClear()
    // connect again for clean state or reuse
    ws = new WebSocket(`ws://localhost:${port}/`)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
    rpcClient = newWebSocketRpcSession(ws as unknown as WebSocket)

    const invalidConfig = {
      services: [
        { name: 123 }, // Invalid type
      ],
    }

    const result = await rpcClient.updateConfig(invalidConfig)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Malformed configuration received and unable to parse')
    }
    // Callback should NOT be called for invalid schema
    expect(updateCallback).not.toHaveBeenCalled()

    ws.close()
  })

  it('should handle gateway update failure', async () => {
    // Setup mock to fail
    updateCallback.mockImplementation(async (_config: unknown) => {
      return { success: false, error: 'Configuration rejected' }
    })

    ws = new WebSocket(`ws://localhost:${port}/`)
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
    rpcClient = newWebSocketRpcSession(ws as unknown as WebSocket)

    const config = {
      services: [{ name: 'test-service', url: 'http://localhost:8080/graphql' }],
    }

    const result = await rpcClient.updateConfig(config)

    expect(result.success).toBe(false)
    if (!result.success) {
      // Narrow type
      expect(result.error).toBe('Configuration rejected')
    }

    ws.close()
  })
})
