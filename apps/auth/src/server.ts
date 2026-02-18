import { AuthService } from '@catalyst/authorization'
import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'

/**
 * The system-wide administrative token minted at startup.
 * Available after startServer() has been called.
 */
export let systemToken: string | undefined

/**
 * Initializes and starts the Auth service.
 */
export async function startServer() {
  const config = loadDefaultConfig()
  const auth = await AuthService.create({ config })

  systemToken = auth.systemToken

  return {
    app: auth.handler,
    port: config.port,
    auth,
    systemToken: auth.systemToken,
  }
}

// Auto-start if this file is the entry point (Bun.main → import.meta.url for Node.js)
if (typeof Bun !== 'undefined' && import.meta.path === Bun.main) {
  startServer()
    .then((result) => {
      catalystHonoServer(result.app, {
        services: [result.auth],
        port: result.port,
      }).start()
    })
    .catch((err) => {
      console.error('Failed to start server:', err)
      process.exit(1)
    })
}
