import { CatalystConfigSchema } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import path from 'node:path'
import { WebUiService } from './service.js'

const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000'
const port = parseInt(process.env.PORT ?? '3000', 10)
const frontendDir = process.env.FRONTEND_DIR ?? path.join(process.cwd(), 'frontend')

const config = CatalystConfigSchema.parse({
  port,
  node: {
    name: process.env.CATALYST_NODE_ID ?? 'web-ui',
    domains: [],
  },
})

const dashboardLinksRaw = process.env.CATALYST_DASHBOARD_LINKS
let dashboardLinks: Record<string, string> | undefined
if (dashboardLinksRaw) {
  dashboardLinks = JSON.parse(dashboardLinksRaw) as Record<string, string>
}

const webUi = new WebUiService({
  config,
  orchestratorUrl,
  frontendDir,
  otelServiceName: process.env.OTEL_SERVICE_NAME,
  envoyUrl: process.env.ENVOY_URL,
  authUrl: process.env.AUTH_URL,
  gatewayUrl: process.env.GATEWAY_URL,
  dashboardLinks,
})
await webUi.initialize()

catalystHonoServer(webUi.handler, {
  services: [webUi],
  port: config.port,
}).start()
