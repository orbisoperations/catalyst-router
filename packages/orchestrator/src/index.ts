import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { newRpcResponse } from '@hono/capnweb'
import { OrchestratorRpcServer } from './rpc/server.js'
import { Session } from './auth/session.js'
import { verifyAndExtractAuth } from './auth/extract.js'
import { AuthClient, type IAuthClient } from './clients/auth.js'
import { getConfig } from './config.js'

export * from './rpc/schema/index.js'

const app = new Hono()
const config = getConfig()

// Initialize auth client if auth is configured
let authClient: IAuthClient | null = null
if (config.authConfig) {
  authClient = new AuthClient(config.authConfig.endpoint)
  console.log('[Auth] Auth client initialized')
}

app.get('/rpc', async (c) => {
  let session: Session

  if (authClient) {
    // Auth enabled: verify token at connection time
    const result = await verifyAndExtractAuth(
      c.req.raw.headers,
      authClient,
      config.authConfig?.audience
    )

    if (!result) {
      return c.text('Unauthorized: Valid JWT required', 401)
    }

    if (!result.auth.userId) {
      return c.text('Unauthorized: Token missing subject claim', 401)
    }

    session = new Session({ auth: result.auth, expiresAt: result.expiresAt })
    const expiryInfo = result.expiresAt
      ? ` expires=${result.expiresAt.toISOString()}`
      : ' expires=never'
    console.log(
      `[RPC] New connection: user=${result.auth.userId} session=${session.connectionId}${expiryInfo}`
    )
  } else {
    return c.text('Service Unavailable: Auth not configured', 503)
  }

  const rpcServer = new OrchestratorRpcServer({ session, config })

  return newRpcResponse(c, rpcServer, {
    upgradeWebSocket,
  })
})

app.get('/health', (c) => c.text('OK'))

const port = process.env.PORT || 4015
console.log(`Orchestrator running on port ${port}`)

// Cleanup on shutdown
const shutdown = () => {
  console.log('[Shutdown] Closing auth client...')
  authClient?.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export default {
  port,
  fetch: app.fetch,
  websocket,
}
