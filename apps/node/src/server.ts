import { AuthService } from '@catalyst/authorization'
import { CatalystConfigSchema, type CatalystConfig } from '@catalyst/config'
import type { CatalystService } from '@catalyst/service'
import { OrchestratorService } from '@catalyst/orchestrator-service'
import { GatewayService } from '@catalyst/gateway-service'
import { getLogger } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { Hono } from 'hono'
import { LinearRouter } from 'hono/router/linear-router'
import { websocket } from 'hono/bun'

export interface CompositeServerOptions {
  nodeId: string
  port: string
  hostname: string
  peeringEndpoint?: string
  domains?: string
  peeringSecret: string
  keysDb: string
  tokensDb: string
  revocation: boolean
  revocationMaxSize?: string
  bootstrapToken?: string
  bootstrapTtl?: string
  gatewayEndpoint?: string
  logLevel: string
}

/**
 * Build a unified CatalystConfig from Commander CLI options.
 *
 * Bypasses loadDefaultConfig() to avoid env-var coupling — all values
 * come from Commander (which itself falls back to env vars as defaults).
 */
export function buildConfig(opts: CompositeServerOptions): CatalystConfig {
  const domains = opts.domains ? opts.domains.split(',').map((d) => d.trim()) : []
  const port = parseInt(opts.port, 10)

  // In composite mode, auto-wire endpoints to the local server unless
  // explicitly overridden. Gateway is at /gateway/api, orchestrator at /orchestrator/rpc.
  const gatewayEndpoint = opts.gatewayEndpoint || `ws://localhost:${port}/gateway/api`
  const peeringEndpoint = opts.peeringEndpoint || `ws://localhost:${port}/orchestrator/rpc`

  return CatalystConfigSchema.parse({
    port,
    node: {
      name: opts.nodeId,
      endpoint: peeringEndpoint,
      domains,
    },
    orchestrator: {
      ibgp: {
        secret: opts.peeringSecret,
      },
      gqlGatewayConfig: {
        endpoint: gatewayEndpoint,
      },
      // orchestrator.auth is wired at startup after the auth service
      // is listening — see startCompositeServer() for the phased init.
    },
    auth: {
      keysDb: opts.keysDb,
      tokensDb: opts.tokensDb,
      revocation: {
        enabled: opts.revocation,
        maxSize: opts.revocationMaxSize ? parseInt(opts.revocationMaxSize, 10) : undefined,
      },
      bootstrap: {
        token: opts.bootstrapToken,
        ttl: opts.bootstrapTtl ? parseInt(opts.bootstrapTtl, 10) : undefined,
      },
    },
  })
}

/**
 * Start the composite Catalyst node with all services mounted on sub-paths:
 *
 *   /auth/*           — Auth service (JWKS, token RPC)
 *   /orchestrator/*   — Orchestrator service (peer/route management RPC)
 *   /gateway/*        — Gateway service (GraphQL, config RPC)
 *   /                 — Node info
 *   /health           — Health check
 *
 * Uses Bun.serve() directly (not CatalystHonoServer) so that routes added
 * after server start are immediately visible. This enables phased init:
 *
 *   Phase 1: Create auth + gateway (no network dependencies), start server
 *   Phase 2: Create orchestrator (connects to auth via loopback for token minting)
 */
export async function startCompositeServer(opts: CompositeServerOptions): Promise<void> {
  const config = buildConfig(opts)
  const logger = getLogger(['catalyst', 'node'])
  // LinearRouter allows adding routes after the first request has been served.
  // SmartRouter (default) compiles on first match and becomes immutable, which
  // breaks phased init where orchestrator routes are added after auth loopback.
  const app = new Hono({ router: new LinearRouter() })
  const services: CatalystService[] = []

  // Telemetry middleware
  app.use(telemetryMiddleware({ ignorePaths: ['/', '/health'] }))

  // Health endpoint — reads services array dynamically
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      services: services.map((s) => s.info.name),
    })
  )

  // Root info endpoint
  app.get('/', (c) =>
    c.json({
      service: 'catalyst-node',
      version: '1.0.0',
      nodeId: config.node.name,
      mounts: {
        auth: '/auth',
        orchestrator: '/orchestrator',
        gateway: '/gateway',
      },
    })
  )

  // --- Phase 1: Auth + Gateway (no network dependencies) ---
  const auth = await AuthService.create({ config })
  app.route('/auth', auth.handler)
  services.push(auth)

  const gateway = await GatewayService.create({ config })
  app.route('/gateway', gateway.handler)
  services.push(gateway)

  // Start server — auth is now reachable via loopback
  const port = config.port
  const hostname = opts.hostname
  const server = Bun.serve({
    fetch: app.fetch,
    port,
    hostname,
    websocket,
  })

  if (server.port !== port) {
    server.stop()
    throw new Error(`Port ${port} is already in use (server bound to ${server.port} instead)`)
  }

  logger.info`Catalyst composite node listening on ${hostname}:${port}`

  // --- Phase 2: Orchestrator (connects to auth via loopback) ---
  const orchestratorConfig = CatalystConfigSchema.parse({
    ...config,
    orchestrator: {
      ...config.orchestrator,
      auth: {
        endpoint: `ws://localhost:${port}/auth/rpc`,
        systemToken: auth.systemToken,
      },
    },
  })

  const orchestrator = await OrchestratorService.create({
    config: orchestratorConfig,
  })
  app.route('/orchestrator', orchestrator.handler)
  services.push(orchestrator)

  logger.info`All services ready: ${services.map((s) => s.info.name).join(', ')}`

  // Graceful shutdown
  const shutdown = async () => {
    await Promise.allSettled(services.map((s) => s.shutdown()))
    server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
