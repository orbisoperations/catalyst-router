import type { CatalystServiceOptions } from '@catalyst/service'
import { CatalystService } from '@catalyst/service'
import { Hono } from 'hono'
import { GatewayGraphqlServer, createGatewayHandler } from './graphql/server.js'
import { GatewayRpcServer, createRpcHandler } from './rpc/server.js'

export class GatewayService extends CatalystService {
  readonly info = { name: 'gateway', version: '0.0.0' }
  readonly handler = new Hono()

  private _graphqlServer!: GatewayGraphqlServer
  private _rpcServer!: GatewayRpcServer

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get graphqlServer(): GatewayGraphqlServer {
    return this._graphqlServer
  }

  get rpcServer(): GatewayRpcServer {
    return this._rpcServer
  }

  protected async onInitialize(): Promise<void> {
    this._graphqlServer = new GatewayGraphqlServer(this.telemetry)
    const { app: graphqlApp } = createGatewayHandler(this._graphqlServer)

    this._rpcServer = new GatewayRpcServer(
      async (config) => this._graphqlServer.reload(config),
      this.telemetry,
      {
        authEndpoint: this.config.orchestrator?.auth?.endpoint,
        nodeId: this.config.node.name,
        domains: this.config.node.domains,
      }
    )
    const rpcApp = createRpcHandler(this._rpcServer.publicApi())

    this.handler.get('/', (c) => c.text('Catalyst GraphQL Gateway is running.'))
    this.handler.route('/graphql', graphqlApp)
    this.handler.route('/api', rpcApp)
  }

  protected async onShutdown(): Promise<void> {
    this.telemetry.logger.info`Gateway shutting down`
  }
}
