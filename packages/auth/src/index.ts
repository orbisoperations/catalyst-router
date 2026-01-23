import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { createKeyManagerFromEnv } from './key-manager/factory.js'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'
import { InMemoryRevocationStore } from './revocation.js'
import {
  InMemoryUserStore,
  InMemoryServiceAccountStore,
  InMemoryBootstrapStore,
} from './stores/memory.js'
import { BootstrapService } from './bootstrap.js'
import { LoginService } from './login.js'
import { ApiKeyService } from './api-key-service.js'
import { hashPassword } from './password.js'

// Initialize KeyManager using factory pattern
const keyManager = createKeyManagerFromEnv()
await keyManager.initialize()

const currentKid = await keyManager.getCurrentKeyId()
console.log(JSON.stringify({ level: 'info', msg: 'KeyManager initialized', kid: currentKid }))

// Initialize revocation store if enabled
const revocationEnabled = process.env.CATALYST_AUTH_REVOCATION === 'true'
const revocationMaxSize = Number(process.env.CATALYST_AUTH_REVOCATION_MAX_SIZE) || undefined
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
const loginService = new LoginService(userStore, keyManager)
const apiKeyService = new ApiKeyService(serviceAccountStore)

// Initialize bootstrap with env token or generate new one
const envBootstrapToken = process.env.CATALYST_BOOTSTRAP_TOKEN
const bootstrapTtl = Number(process.env.CATALYST_BOOTSTRAP_TTL) || 24 * 60 * 60 * 1000 // 24h default

if (envBootstrapToken) {
  // Use provided bootstrap token from environment
  const tokenHash = await hashPassword(envBootstrapToken)
  const expiresAt = new Date(Date.now() + bootstrapTtl)
  await bootstrapStore.set({ tokenHash, expiresAt, used: false })
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'Bootstrap initialized from env',
      expiresAt: expiresAt.toISOString(),
    })
  )
} else {
  // Generate new bootstrap token
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

// Initialize the RPC server with all services
const rpcServer = new AuthRpcServer(
  keyManager,
  revocationStore,
  bootstrapService,
  loginService,
  apiKeyService
)
const rpcApp = createAuthRpcHandler(rpcServer)

// Health check endpoint
app.get('/', (c) => c.text('Catalyst Auth Service'))
app.get('/health', (c) => c.json({ status: 'ok' }))

// JWKS endpoint (standard path for key discovery)
app.get('/.well-known/jwks.json', async (c) => {
  const jwks = await keyManager.getJwks()
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(jwks)
})

// Mount the RPC handler
app.route('/rpc', rpcApp)

const port = Number(process.env.PORT) || 4001
console.log(JSON.stringify({ level: 'info', msg: 'Auth service started', port }))

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log(JSON.stringify({ level: 'info', msg: 'Shutting down...' }))
  await keyManager.shutdown()
  process.exit(0)
})

export default {
  fetch: app.fetch,
  port,
  websocket,
}

// Re-export for library usage
export * from './keys.js'
export {
  signToken,
  verifyToken,
  decodeToken,
  SignOptionsSchema,
  VerifyResultSchema,
} from './jwt.js'
export type { SignOptions, VerifyOptions, VerifyResult } from './jwt.js'
export * from './revocation.js'
export * from './key-manager/index.js'
export * from './rpc/schema.js'
export { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'
