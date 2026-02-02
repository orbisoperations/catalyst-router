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
import {
    LocalTokenManager,
    BunSqliteTokenStore
} from '@catalyst/authorization'
import { BootstrapService } from './bootstrap.js'
import { LoginService } from './login.js'
import { ApiKeyService } from './api-key-service.js'
import { hashPassword } from './password.js'
import { Permission } from './permissions.js'

/**
 * The system-wide administrative token minted at startup.
 * Available after startServer() has been called.
 */
export let systemToken: string | undefined

/**
 * Initializes and starts the Auth service.
 */
export async function startServer() {
    // Initialize KeyManager using factory pattern
    const keyManager = createKeyManagerFromEnv()
    await keyManager.initialize()

    const currentKid = await keyManager.getCurrentKeyId()
    console.log(JSON.stringify({ level: 'info', msg: 'KeyManager initialized', kid: currentKid }))

    // Initialize token tracking
    const tokenStore = new BunSqliteTokenStore(process.env.CATALYST_AUTH_DB || 'auth.db')
    const tokenManager = new LocalTokenManager(keyManager, tokenStore)

    // Mint system admin token
    systemToken = await tokenManager.mint({
        subject: 'system-admin',
        entity: {
            id: 'system',
            name: 'System Admin',
            type: 'service',
        },
        claims: {
            role: 'admin',
            permissions: [
                Permission.TokenCreate,
                Permission.TokenRevoke,
                Permission.TokenList,
                Permission.PeerCreate,
                Permission.PeerUpdate,
                Permission.PeerDelete,
                Permission.RouteCreate,
                Permission.RouteDelete,
                Permission.IbgpConnect,
                Permission.IbgpDisconnect,
                Permission.IbgpUpdate,
            ],
        },
    })

    console.log(JSON.stringify({ level: 'info', msg: 'System Admin Token minted', token: systemToken }))

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
    const loginService = new LoginService(userStore, tokenManager)
    const apiKeyService = new ApiKeyService(serviceAccountStore)

    // Initialize bootstrap with env token or generate new one
    const envBootstrapToken = process.env.CATALYST_BOOTSTRAP_TOKEN
    const bootstrapTtl = Number(process.env.CATALYST_BOOTSTRAP_TTL) || 24 * 60 * 60 * 1000 // 24h default

    if (envBootstrapToken) {
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
        revocationStore,
        bootstrapService,
        loginService,
        apiKeyService
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

    const port = Number(process.env.PORT) || 4001
    console.log(JSON.stringify({ level: 'info', msg: 'Auth service started', port }))

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
    startServer().catch((err) => {
        console.error('Failed to start server:', err)
        process.exit(1)
    })
}

export default {
    fetch: async (req: Request) => {
        // This is for Bun's default export support, though usually we'd call startServer
        // If not started, we'd need to handle it. For now, we assume startServer is the way.
        const result = await startServer()
        return result.app.fetch(req)
    },
}
