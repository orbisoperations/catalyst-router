import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { newRpcResponse } from '@hono/capnweb'
import { CatalystNodeBus } from './orchestrator.js'

import { loadDefaultConfig } from '@catalyst/config'

const app = new Hono()

const config = loadDefaultConfig()

const bus = new CatalystNodeBus({
  config: config.orchestrator
    ? {
        ...config.orchestrator,
        node: {
          ...config.node,
          endpoint: config.node.endpoint!, // Orchestrator requires an endpoint
        },
      }
    : {
        node: {
          ...config.node,
          endpoint: config.node.endpoint!,
        },
      },
  connectionPool: { type: 'ws' },
})

app.all('/rpc', (c) => {
  return newRpcResponse(c, bus.publicApi(), {
    upgradeWebSocket,
  })
})

app.get('/health', (c) => c.text('OK'))

const port = config.port
const nodeName = config.node.name

console.log(`Orchestrator (Next) running on port ${port} as ${nodeName}`)
console.log('NEXT_ORCHESTRATOR_STARTED')

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket,
}
