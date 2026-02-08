import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { newRpcResponse } from '@hono/capnweb'
import { CatalystNodeBus } from './orchestrator.js'
import { newWebSocketRpcSession } from 'capnweb'
import { Role } from '@catalyst/authorization'
import { TelemetryBuilder, shutdownTelemetry } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'

import { loadDefaultConfig } from '@catalyst/config'

const app = new Hono()

const config = loadDefaultConfig()

let telemetry: ServiceTelemetry
try {
  telemetry = await new TelemetryBuilder('orchestrator')
    .withLogger({ category: ['catalyst', 'orchestrator'] })
    .withMetrics()
    .withTracing()
    .withRpcInstrumentation()
    .build()
} catch (err) {
  process.stderr.write(`[orchestrator] telemetry init failed, falling back to noop: ${err}\n`)
  telemetry = TelemetryBuilder.noop('orchestrator')
}
const { logger } = telemetry
const tokenLogger = logger.getChild('token')

/**
 * Auth Service Integration
 *
 * If auth service config is provided:
 * 1. Connect to auth service via RPC
 * 2. Use system token to mint NODE token
 * 3. Store NODE token for authorization checks
 */
interface AuthRpcApi {
  tokens(token: string): Promise<
    | {
        create(request: {
          subject: string
          entity: {
            id: string
            name: string
            type: 'user' | 'service'
            role: string
            nodeId?: string
          }
          roles: string[]
          sans?: string[]
          expiresIn?: string
        }): Promise<string>
        revoke(request: { jti?: string; san?: string }): Promise<void>
        list(request: { certificateFingerprint?: string; san?: string }): Promise<unknown[]>
      }
    | { error: string }
  >
}

let nodeToken: string | undefined
let tokenIssuedAt: Date | undefined
let tokenExpiresAt: Date | undefined

// Token refresh threshold: refresh when 80% of TTL has elapsed
const REFRESH_THRESHOLD = 0.8
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds

async function mintNodeToken() {
  if (!config.orchestrator?.auth) {
    tokenLogger.info`no auth service configured - skipping node token mint`
    return
  }

  const { endpoint, systemToken } = config.orchestrator.auth
  tokenLogger.info`connecting to auth service at ${endpoint}`

  try {
    const authClient = newWebSocketRpcSession<AuthRpcApi>(endpoint)
    const tokensApi = await authClient.tokens(systemToken)

    if ('error' in tokensApi) {
      throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
    }

    // Mint NODE token
    nodeToken = await tokensApi.create({
      subject: config.node.name,
      entity: {
        id: config.node.name,
        name: config.node.name,
        type: 'service',
        role: Role.NODE,
        nodeId: config.node.name,
        trustedNodes: [], // Empty for now - could be populated from peer config
        trustedDomains: config.node.domains, // Domains this node trusts
      },
      roles: [Role.NODE],
      expiresIn: '7d', // Node token valid for 7 days
    })

    // Track issue and expiry times for refresh logic
    tokenIssuedAt = new Date()
    tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS)

    tokenLogger.info`node token minted for ${config.node.name}`
    tokenLogger.info`token issued at ${tokenIssuedAt.toISOString()}`
    tokenLogger.info`token expires at ${tokenExpiresAt.toISOString()}`
  } catch (error) {
    tokenLogger.error`failed to mint node token: ${error}`
    throw error
  }
}

/**
 * Check if token needs refresh and re-mint if necessary.
 * Refreshes when 80% of TTL has elapsed to avoid token expiration during operations.
 */
async function refreshNodeTokenIfNeeded() {
  if (!config.orchestrator?.auth || !tokenIssuedAt || !tokenExpiresAt) {
    return
  }

  const now = Date.now()
  const issuedTime = tokenIssuedAt.getTime()
  const expiryTime = tokenExpiresAt.getTime()
  const totalLifetime = expiryTime - issuedTime
  const refreshTime = issuedTime + totalLifetime * REFRESH_THRESHOLD

  if (now >= refreshTime) {
    tokenLogger.info`node token approaching expiration, refreshing`
    try {
      await mintNodeToken()
      tokenLogger.info`node token refreshed`
    } catch (error) {
      tokenLogger.error`failed to refresh node token: ${error}`
      // Don't throw - keep using existing token until it expires
    }
  }
}

// Mint node token before starting the server
await mintNodeToken()

// Set up periodic token refresh check (every hour)
if (config.orchestrator?.auth) {
  const REFRESH_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
  setInterval(refreshNodeTokenIfNeeded, REFRESH_CHECK_INTERVAL)
  tokenLogger.info`token refresh check enabled (every hour)`
}

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
  nodeToken,
  authEndpoint: config.orchestrator?.auth?.endpoint,
  telemetry,
})

app.use(telemetryMiddleware({ ignorePaths: ['/health'] }))

const instrumentedApi = telemetry.instrumentRpc(bus.publicApi())
app.all('/rpc', (c) => {
  return newRpcResponse(c, instrumentedApi, {
    upgradeWebSocket,
  })
})

app.get('/health', (c) => c.text('OK'))

const port = config.port
const nodeName = config.node.name

logger.info`Orchestrator running on port ${port} as ${nodeName}`
process.stdout.write('NEXT_ORCHESTRATOR_STARTED\n')

const shutdown = async () => {
  logger.info`shutting down orchestrator...`
  await shutdownTelemetry()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket,
}
