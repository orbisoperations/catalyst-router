import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { newWebSocketRpcSession } from 'capnweb'
import { createTestWebSocketServer, type TestServerInfo } from '@catalyst/service'
import type { GatewayUpdateResult } from '../src/rpc/server.js'
import { createRpcHandler, GatewayRpcServer } from '../src/rpc/server.js'

describe('RPC Integration', () => {
  let testServer: TestServerInfo
  let port: number
  let ws: WebSocket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rpcClient: any

  // Mock callback
  const updateCallback = vi.fn(async (_config: unknown): Promise<GatewayUpdateResult> => {
    return { success: true }
  })

  beforeAll(async () => {
    testServer = await createTestWebSocketServer(() => {
      const rpcServer = new GatewayRpcServer(updateCallback)
      return createRpcHandler(rpcServer)
    })
    port = testServer.port
  })

  afterAll(() => {
    if (testServer) testServer.stop()
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
