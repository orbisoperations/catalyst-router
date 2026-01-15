import { RpcTarget } from 'capnweb'
import type {
  Action,
  AddDataChannelResult,
  ListLocalRoutesResult,
  ListMetricsResult,
} from './schema/index.js'
import { GlobalRouteTable } from '../state/route-table.js'
import { PluginPipeline } from '../plugins/pipeline.js'
import { AuthPlugin } from '../plugins/implementations/auth.js'
import { LoggerPlugin } from '../plugins/implementations/logger.js'
// import { StatePersistencePlugin } from '../plugins/implementations/state.js';
import { RouteTablePlugin } from '../plugins/implementations/routing.js'
// import { RouteAnnouncerPlugin } from '../plugins/implementations/announcer.js';
import { GatewayIntegrationPlugin } from '../plugins/implementations/gateway.js'
import { DirectProxyRouteTablePlugin } from '../plugins/implementations/proxy-route.js'
import type { OrchestratorConfig } from '../config.js'
import type { Session } from '../auth/session.js'

export interface OrchestratorRpcServerOptions {
  session: Session
  config: OrchestratorConfig
}

export class OrchestratorRpcServer extends RpcTarget {
  private pipeline: PluginPipeline
  private session: Session

  constructor(options: OrchestratorRpcServerOptions) {
    super()
    const { session, config } = options
    this.session = session

    // Initialize Plugins
    const plugins: any[] = []

    // Auth plugin checks RBAC permissions using session auth
    plugins.push(new AuthPlugin())

    plugins.push(
      new LoggerPlugin(),
      // new StatePersistencePlugin(),
      new RouteTablePlugin(),
      new DirectProxyRouteTablePlugin()
      // new RouteAnnouncerPlugin(),
    )

    // Conditionally add Gateway Plugin
    if (config.gqlGatewayConfig) {
      plugins.push(
        new GatewayIntegrationPlugin({
          gatewayEndpoint: config.gqlGatewayConfig.endpoint,
          authJwksUrl: config.authConfig?.jwksUrl,
        })
      )
    }

    this.pipeline = new PluginPipeline(plugins)
  }

  getSession(): Session {
    return this.session
  }

  async applyAction(request: { action: Action }): Promise<AddDataChannelResult> {
    // Check if session token has expired
    if (this.session.isExpired()) {
      console.warn(
        `[RPC] Session expired: user=${this.session.auth.userId} ` +
          `session=${this.session.connectionId} expired=${this.session.expiresAt?.toISOString()}`
      )
      return {
        success: false,
        error: 'Session expired: Please reconnect with a fresh token',
      }
    }

    try {
      const result = await this.pipeline.apply({
        action: request.action,
        state: GlobalRouteTable,
        authxContext: this.session.auth,
      })

      if (!result.success) {
        return { success: false, error: result.error.message }
      }

      return {
        success: true,
        id: result.ctx.result?.id,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async listLocalRoutes(): Promise<ListLocalRoutesResult> {
    const routes = GlobalRouteTable.getRoutes()
    return { routes }
  }

  async listMetrics(): Promise<ListMetricsResult> {
    const metrics = GlobalRouteTable.getMetrics()
    return { metrics }
  }
}
