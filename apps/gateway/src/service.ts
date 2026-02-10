import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { GatewayGraphqlServer, createGatewayHandler } from './graphql/server.js'
import { GatewayRpcServer, createRpcHandler } from './rpc/server.js'

export class GatewayService extends CatalystService {
  readonly info = { name: 'gateway', version: '0.0.0' }
  readonly handler = new Hono()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    const { app: graphqlApp, server: gateway } = createGatewayHandler(
      new GatewayGraphqlServer(this.telemetry)
    )

    const rpcServer = new GatewayRpcServer(async (config) => gateway.reload(config), this.telemetry)
    const instrumentedRpc = this.telemetry.instrumentRpc(rpcServer)
    const rpcApp = createRpcHandler(instrumentedRpc)

    this.handler.get('/', (c) => c.text('Catalyst GraphQL Gateway is running.'))
    this.handler.route('/graphql', graphqlApp)
    this.handler.route('/api', rpcApp)
  }
}
