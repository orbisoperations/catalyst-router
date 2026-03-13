/**
 * Starts a mock orchestrator + web-ui server for Playwright E2E tests.
 *
 * The mock orchestrator returns realistic (but credential-free) state data.
 * The web-ui service serves the built frontend and proxies API requests.
 *
 * Shuts down gracefully on SIGTERM.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { CatalystConfigSchema } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { WebUiService } from '../../src/service.js'
import path from 'node:path'

// ── Mock orchestrator state ─────────────────────────────────────────
const mockState = {
  routes: {
    local: [{ name: 'books-api', endpoint: 'http://books:8080/graphql', protocol: 'http:graphql' }],
    internal: [
      {
        name: 'movies-api',
        endpoint: 'http://movies:8080/graphql',
        protocol: 'http:graphql',
        peer: { name: 'node-b.dev.catalyst.local', domains: ['dev.catalyst.local'] },
        nodePath: ['node-b.dev.catalyst.local'],
      },
    ],
  },
  peers: [
    {
      name: 'node-b.dev.catalyst.local',
      endpoint: 'ws://node-b:3000/rpc',
      domains: ['dev.catalyst.local'],
      connectionStatus: 'connected',
    },
  ],
}

// ── Start mock orchestrator ─────────────────────────────────────────
const orchApp = new Hono()
orchApp.get('/api/state', (c) => c.json(mockState))
orchApp.get('/health', (c) => c.json({ status: 'ok' }))

const mockOrchServer = serve({ fetch: orchApp.fetch, port: 0 })
const orchPort = (mockOrchServer.address() as { port: number }).port

// ── Start web-ui service ────────────────────────────────────────────
const frontendDir = path.resolve(import.meta.dirname, '../../dist/frontend')

const config = CatalystConfigSchema.parse({
  port: 0,
  node: { name: 'web-ui-e2e', domains: [] },
})

const webUi = new WebUiService({
  config,
  orchestratorUrl: `http://localhost:${orchPort}`,
  frontendDir,
  otelServiceName: 'test-orchestrator',
  envoyUrl: `http://localhost:${orchPort}`,
  authUrl: `http://localhost:${orchPort}`,
  gatewayUrl: `http://localhost:${orchPort}`,
  dashboardLinks: { metrics: 'http://grafana/{service}', traces: 'http://jaeger/{service}' },
})
await webUi.initialize()

const webUiPort = parseInt(process.env.PORT ?? '3099', 10)
const webUiServer = catalystHonoServer(webUi.handler, {
  services: [webUi],
  port: webUiPort,
})
await webUiServer.start()

// Signal to Playwright that the server is ready
console.log(`Listening on http://localhost:${webUiPort}`)

// Graceful shutdown
process.on('SIGTERM', async () => {
  mockOrchServer.close()
  await webUiServer.stop().catch(() => {})
  process.exit(0)
})

process.on('SIGINT', async () => {
  mockOrchServer.close()
  await webUiServer.stop().catch(() => {})
  process.exit(0)
})
