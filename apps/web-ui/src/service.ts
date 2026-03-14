import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { createDashboardRoutes } from './routes/dashboard.js'

export interface WebUiServiceOptions extends CatalystServiceOptions {
  /** Base URL of the orchestrator to proxy dashboard API requests to. */
  readonly orchestratorUrl: string
  /** Absolute path to the directory containing the built frontend assets. */
  readonly frontendDir: string
  /** OTEL service name for the orchestrator (for health check display). */
  readonly otelServiceName?: string
  /** Envoy health URL (optional). */
  readonly envoyUrl?: string
  /** Auth health URL (optional). */
  readonly authUrl?: string
  /** Gateway health URL (optional). */
  readonly gatewayUrl?: string
  /** Dashboard link templates (optional). */
  readonly dashboardLinks?: Record<string, string>
}

export class WebUiService extends CatalystService {
  readonly info = { name: 'web-ui', version: '0.0.0' }
  readonly handler = new Hono()

  private readonly options: WebUiServiceOptions

  constructor(options: WebUiServiceOptions) {
    super(options)
    this.options = options
  }

  protected async onInitialize(): Promise<void> {
    // Mount dashboard API routes
    this.handler.route(
      '/api',
      createDashboardRoutes({
        orchestratorUrl: this.options.orchestratorUrl,
        otelServiceName: this.options.otelServiceName ?? 'orchestrator',
        envoyUrl: this.options.envoyUrl,
        authUrl: this.options.authUrl,
        gatewayUrl: this.options.gatewayUrl,
        dashboardLinks: this.options.dashboardLinks,
      })
    )

    // Serve static frontend files
    this.handler.use('/*', serveStatic({ root: this.options.frontendDir }))
    // SPA fallback — serve index.html for all unmatched routes
    this.handler.get('/*', serveStatic({ root: this.options.frontendDir, path: 'index.html' }))
  }
}
