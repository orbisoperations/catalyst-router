import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { TelemetryBuilder, shutdownTelemetry } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { GatewayGraphqlServer, createGatewayHandler } from './graphql/server.js'
import { GatewayRpcServer, createRpcHandler } from './rpc/server.js'

const port = Number(process.env.PORT) || 4000

async function main() {
  // Initialize telemetry before server starts
  let telemetry: ServiceTelemetry
  try {
    telemetry = await new TelemetryBuilder('gateway')
      .withLogger({ category: ['catalyst', 'gateway'] })
      .withMetrics()
      .withTracing()
      .withRpcInstrumentation()
      .build()
  } catch (err) {
    // Non-fatal telemetry failure — stderr is acceptable here since
    // the logger isn't available yet (bootstrap chicken-and-egg).
    process.stderr.write(`[gateway] telemetry init failed, falling back to noop: ${err}\n`)
    telemetry = TelemetryBuilder.noop('gateway')
  }

  const { logger } = telemetry

  const app = new Hono()

  // HTTP telemetry middleware (before routes)
  // @ts-expect-error -- TODO: hono peer dep causes MiddlewareHandler generic mismatch across packages
  app.use(telemetryMiddleware({ ignorePaths: ['/', '/health'] }))

  // Construct with DI
  const { app: graphqlApp, server: gateway } = createGatewayHandler(
    new GatewayGraphqlServer(telemetry)
  )

  // Wrap RPC server with instrumentation
  const rpcServer = new GatewayRpcServer(async (config) => gateway.reload(config), telemetry)
  const instrumentedRpc = telemetry.instrumentRpc(rpcServer)
  const rpcApp = createRpcHandler(instrumentedRpc)

  // Mount routes
  app.get('/', (c) => c.text('Catalyst GraphQL Gateway is running.'))
  app.route('/graphql', graphqlApp)
  app.route('/api', rpcApp)

  // Graceful shutdown
  const shutdown = async () => {
    await shutdownTelemetry()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  logger.info`Gateway starting on port ${port}`
  logger.info`Gateway started`

  return { fetch: app.fetch, port, hostname: '0.0.0.0', websocket }
}

export default await main()
