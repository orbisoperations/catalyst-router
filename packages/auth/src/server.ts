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
  // Initialize logging
  const { configureLogging, getAuthLogger } = await import('./logger.js')
  configureLogging()
  const logger = getAuthLogger()

  const config = loadDefaultConfig()

  // Initialize Key persistence
  const keyStore = new BunSqliteKeyStore(config.auth?.keysDb || 'keys.db')
  const keyManager = new PersistentLocalKeyManager(keyStore)
  await keyManager.initialize()

  const currentKid = await keyManager.getCurrentKeyId()
  void logger.info`KeyManager initialized with kid: ${currentKid}`

  // initialize the policy authorization engine using the standard Catalyst domain
  const policyService = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)
  const validationResult = policyService.validatePolicies()
  if (!validationResult) {
    void logger.error`Invalid policies - policy validation failed`
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

  void logger.info`System Admin Token minted: ${systemToken}`

  // Initialize revocation store if enabled
  const revocationEnabled = config.auth?.revocation?.enabled === true
  const revocationMaxSize = config.auth?.revocation?.maxSize
  const revocationStore = revocationEnabled
    ? new InMemoryRevocationStore({ maxSize: revocationMaxSize })
    : undefined

  if (revocationStore) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'Token revocation enabled',
        maxSize: revocationStore.maxSize,
      })
    )
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
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'Bootstrap initialized from config',
        expiresAt: expiresAt.toISOString(),
      })
    )
  } else {
    const result = await bootstrapService.initializeBootstrap({ expiresInMs: bootstrapTtl })
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'Bootstrap token generated',
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      })
    )
  }

  const app = new Hono()
  const rpcServer = new AuthRpcServer(
    keyManager,
    tokenManager,
    bootstrapService,
    loginService,
    apiKeyService,
    policyService,
    config.node.name,
    config.node.domains[0] || ''
  )
  rpcServer.setSystemToken(systemToken)
  const rpcApp = createAuthRpcHandler(rpcServer)

  app.get('/', (c) => c.text('Catalyst Auth Service'))
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/.well-known/jwks.json', async (c) => {
    const jwks = await keyManager.getJwks()
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(jwks)
  })
  app.route('/rpc', rpcApp)

  const port = config.port
  console.log(JSON.stringify({ level: 'info', msg: 'Auth service started', port }))
  console.log('Auth service started') // Plain log for container tests

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...' }))
    await keyManager.shutdown()
    process.exit(0)
  })

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
      console.log(`Started development server: http://localhost:${result.port}`)
    })
    .catch((err) => {
      console.error('Failed to start server:', err)
      process.exit(1)
    })
}
