import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { newRpcResponse } from '@hono/capnweb'
import { CatalystNodeBus } from './orchestrator.js'

const app = new Hono()

const nodeId = process.env.CATALYST_NODE_ID
if (!nodeId) {
  throw new Error('CATALYST_NODE_ID is required (must be FQDN ending in .somebiz.local.io)')
}
const peeringEndpoint = process.env.CATALYST_PEERING_ENDPOINT
if (!peeringEndpoint) {
  throw new Error('CATALYST_PEERING_ENDPOINT is required (reachable endpoint for this node)')
}
const domains = process.env.CATALYST_DOMAINS
  ? process.env.CATALYST_DOMAINS.split(',').map((d) => d.trim())
  : []

const bus = new CatalystNodeBus({
  config: {
    node: {
      name: nodeId,
      endpoint: peeringEndpoint,
      domains: domains,
    },
    ibgp: {
      secret: process.env.CATALYST_PEERING_SECRET || 'valid-secret',
    },
    gqlGatewayConfig: process.env.CATALYST_GQL_GATEWAY_ENDPOINT
      ? { endpoint: process.env.CATALYST_GQL_GATEWAY_ENDPOINT }
      : undefined,
  },
  connectionPool: { type: 'ws' },
})

app.all('/rpc', (c) => {
  return newRpcResponse(c, bus.publicApi(), {
    upgradeWebSocket,
  })
})

app.get('/health', (c) => c.text('OK'))

const port = Number(process.env.PORT) || 3000

console.log(`Orchestrator (Next) running on port ${port} as ${nodeId}`)
console.log(`NEXT_ORCHESTRATOR_STARTED: Node: ${nodeId}`)

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket,
}
