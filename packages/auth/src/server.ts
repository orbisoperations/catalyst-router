import {
  ALL_POLICIES,
  AuthorizationEngine,
  BunSqliteKeyStore,
  BunSqliteTokenStore,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  LocalTokenManager,
  PersistentLocalKeyManager,
  Role,
} from '@catalyst/authorization'
import { loadDefaultConfig } from '@catalyst/config'
import { TelemetryBuilder, shutdownTelemetry } from '@catalyst/telemetry'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { ApiKeyService } from './api-key-service.js'
import { BootstrapService } from './bootstrap.js'
import { LoginService } from './login.js'
import { hashPassword } from './password.js'
import { InMemoryRevocationStore } from './revocation.js'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'
import {
  InMemoryBootstrapStore,
  InMemoryServiceAccountStore,
  InMemoryUserStore,
} from './stores/memory.js'

/**
 * The system-wide administrative token minted at startup.
 * Available after startServer() has been called.
 */
export let systemToken: string | undefined

/**
 * Initializes and starts the Auth service.
 */
export async function startServer() {
  // Initialize telemetry
  let telemetry: ServiceTelemetry
  try {
    telemetry = await new TelemetryBuilder('auth')
      .withLogger({ category: ['catalyst', 'auth'] })
      .withMetrics()
      .withTracing()
      .withRpcInstrumentation()
      .build()
  } catch (err) {
    process.stderr.write(`[auth] telemetry init failed, falling back to noop: ${err}\n`)
    telemetry = TelemetryBuilder.noop('auth')
  }

  const { logger } = telemetry

  const config = loadDefaultConfig()

  // Initialize Key persistence
  const keyStore = new BunSqliteKeyStore(config.auth?.keysDb || 'keys.db')
  const keyManager = new PersistentLocalKeyManager(keyStore)
  await keyManager.initialize()

  const currentKid = await keyManager.getCurrentKeyId()
  logger.info`KeyManager initialized with kid: ${currentKid}`

  // initialize the policy authorization engine using the standard Catalyst domain
  const policyService = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)
  const validationResult = policyService.validatePolicies()
  if (!validationResult) {
    logger.error`Invalid policies - policy validation failed`
    process.exit(1)
  }

  // Initialize token tracking
  const tokenStore = new BunSqliteTokenStore(config.auth?.tokensDb || 'tokens.db')
  const tokenManager = new LocalTokenManager(keyManager, tokenStore, config.node.name)

  // Mint system admin token
  systemToken = await tokenManager.mint({
    subject: 'bootstrap',
    entity: {
      id: 'system',
      name: 'System Admin',
      type: 'service',
      role: Role.ADMIN,
      trustedDomains: config.node.domains, // Required for Cedar policy
      trustedNodes: [], // Empty = trust all nodes
    },
    roles: [Role.ADMIN],
    // 365days in milliseconds unix timestamp
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  })

  logger.info`System Admin Token minted: ${systemToken}`

  // Initialize revocation store if enabled
  const revocationEnabled = config.auth?.revocation?.enabled === true
  const revocationMaxSize = config.auth?.revocation?.maxSize
  const revocationStore = revocationEnabled
    ? new InMemoryRevocationStore({ maxSize: revocationMaxSize })
    : undefined

  if (revocationStore) {
    logger.info`Token revocation enabled - maxSize: ${revocationStore.maxSize}`
  }

  // Initialize stores
  const userStore = new InMemoryUserStore()
  const serviceAccountStore = new InMemoryServiceAccountStore()
  const bootstrapStore = new InMemoryBootstrapStore()

  // Initialize services
  const bootstrapService = new BootstrapService(userStore, bootstrapStore)
  const loginService = new LoginService(userStore, tokenManager)
  const apiKeyService = new ApiKeyService(serviceAccountStore)

  // Initialize bootstrap with env token or generate new one
  const envBootstrapToken = config.auth?.bootstrap?.token
  const bootstrapTtl = config.auth?.bootstrap?.ttl || 24 * 60 * 60 * 1000 // 24h default

  if (envBootstrapToken) {
    const tokenHash = await hashPassword(envBootstrapToken)
    const expiresAt = new Date(Date.now() + bootstrapTtl)
    await bootstrapStore.set({ tokenHash, expiresAt, used: false })
    logger.info`Bootstrap initialized from config - expiresAt: ${expiresAt.toISOString()}`
  } else {
    const result = await bootstrapService.initializeBootstrap({ expiresInMs: bootstrapTtl })
    logger.info`Bootstrap token generated - token: ${result.token}, expiresAt: ${result.expiresAt.toISOString()}`
  }

  const app = new Hono()

  // HTTP telemetry middleware (before routes)
  // @ts-expect-error -- hono peer dep causes MiddlewareHandler generic mismatch across packages
  app.use(telemetryMiddleware({ ignorePaths: ['/', '/health'] }))

  const rpcServer = new AuthRpcServer(
    keyManager,
    tokenManager,
    bootstrapService,
    loginService,
    apiKeyService,
    policyService,
    config.node.name,
    config.node.domains[0] || '',
    telemetry
  )
  rpcServer.setSystemToken(systemToken)
  const instrumentedRpc = telemetry.instrumentRpc(rpcServer)
  const rpcApp = createAuthRpcHandler(instrumentedRpc)

  app.get('/', (c) => c.text('Catalyst Auth Service'))
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/.well-known/jwks.json', async (c) => {
    const jwks = await keyManager.getJwks()
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(jwks)
  })
  app.route('/rpc', rpcApp)

  const port = config.port
  logger.info`Auth service started on port ${port}`

  // Graceful shutdown
  const shutdown = async () => {
    logger.info`Shutting down auth service...`
    await keyManager.shutdown()
    await shutdownTelemetry()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return {
    app,
    port,
    websocket,
    systemToken,
  }
}

// Auto-start if this file is the entry point
if (import.meta.path === Bun.main) {
  startServer()
    .then((result) => {
      Bun.serve({
        fetch: result.app.fetch,
        websocket: result.websocket,
        port: result.port,
        hostname: '0.0.0.0',
      })
      process.stdout.write(`Started development server: http://localhost:${result.port}\n`)
    })
    .catch((err) => {
      process.stderr.write(`Failed to start server: ${err}\n`)
      process.exit(1)
    })
}
