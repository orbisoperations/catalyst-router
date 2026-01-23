import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi, ManagementScope } from '../../cli/src/client.js'
import type {
  Action,
  LocalRoute,
  DataChannelMetrics,
  ListMetricsResult,
} from '../src/rpc/schema/index.js'
import app from '../src/index.js'

describe('Orchestrator RPC', () => {
  let server: ReturnType<typeof Bun.serve>
  let rpc: ReturnType<typeof newWebSocketRpcSession<PublicApi>>
  let ws: WebSocket
  const port = 4017

  beforeAll(async () => {
    server = Bun.serve({
      port,
      fetch: app.fetch,
      websocket: app.websocket,
    })

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100))

    ws = new WebSocket(`ws://localhost:${port}/rpc`)
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => resolve())
    })

    rpc = newWebSocketRpcSession(ws as unknown as WebSocket)
  })

  afterAll(() => {
    if (ws) ws.close()
    server.stop()
  })

  it('should apply create data channel action', async () => {
    const action = {
      resource: 'localRoute',
      resourceAction: 'create',
      data: {
        name: 'test-service',
        endpoint: 'http://127.0.0.1:8080',
        protocol: 'http:graphql',
        region: 'us-west-1',
      },
    }

    const cli = rpc.connectionFromManagementSDK() as unknown as ManagementScope
    const result = await cli.applyAction(action as unknown as Action)
    expect(result.success).toBe(true)
    expect(result.results[0].id).toBe('test-service:http:graphql')
  })

  it('should list local routes', async () => {
    const cli = rpc.connectionFromManagementSDK() as unknown as ManagementScope
    const result = await cli.listLocalRoutes()
    expect(result.routes).toBeInstanceOf(Array)
    expect(result.routes.length).toBeGreaterThan(0)
    const route = result.routes.find((r: LocalRoute) => r.id === 'test-service:http:graphql')
    expect(route).toBeDefined()
    expect(route!.service.name).toBe('test-service')
  })

  it('should list metrics', async () => {
    const cli = rpc.connectionFromManagementSDK() as unknown as ManagementScope
    const result = (await cli.listMetrics()) as ListMetricsResult
    expect(result.metrics).toBeInstanceOf(Array)
    const metric = (result.metrics as DataChannelMetrics[]).find(
      (m: DataChannelMetrics) => m.id === 'test-service:http:graphql'
    )
    expect(metric).toBeDefined()
    expect(metric!.connectionCount).toBe(0)
  })
})
