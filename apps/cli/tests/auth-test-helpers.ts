import type { Readable } from 'node:stream'
import type { StartedNetwork, StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'

export interface AuthServiceContext {
  container: StartedTestContainer
  systemToken: string
  endpoint: string
}

/**
 * Starts an auth service container and extracts the system token.
 *
 * @param network - Docker network to attach to
 * @param alias - Network alias for the auth service
 * @param authImage - Docker image name for auth service
 * @param env - Optional extra environment variables to merge with defaults
 * @param port - Port to expose (default: 5000)
 * @returns Auth service context with container, system token, and endpoint
 */
export async function startAuthService(
  network: StartedNetwork,
  alias: string,
  authImage: string,
  env: Record<string, string> = {},
  port = 5000
): Promise<AuthServiceContext> {
  console.log(`Starting auth service ${alias}...`)
  const authLogs: string[] = []

  const container = await new GenericContainer(authImage)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withExposedPorts(port)
    .withEnvironment({
      PORT: port.toString(),
      CATALYST_NODE_ID: alias,
      CATALYST_AUTH_KEYS_DB: ':memory:',
      CATALYST_AUTH_TOKENS_DB: ':memory:',
      ...env,
    })
    .withWaitStrategy(Wait.forLogMessage('Catalyst server [auth] listening'))
    .withLogConsumer((stream: Readable) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString()
        authLogs.push(text)
        process.stdout.write(`[${alias}] ${text}`)
      })
    })
    .start()

  console.log(`Auth service ${alias} started, extracting system token...`)

  // Retry to handle the race between wait strategy and log consumer
  let systemToken: string | undefined
  for (let i = 0; i < 20; i++) {
    try {
      systemToken = extractSystemTokenFromLogs(authLogs)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  if (!systemToken) {
    throw new Error(`Failed to extract system token from ${alias} logs after multiple attempts`)
  }

  console.log(`[${alias}] Extracted system token: ${systemToken.substring(0, 20)}...`)

  return {
    container,
    systemToken,
    endpoint: `ws://${alias}:${port}/rpc`,
  }
}

/**
 * Extracts the system token from auth service log output.
 *
 * @param logs - Array of log lines from auth service
 * @returns System token string
 * @throws Error if system token not found in logs
 */
export function extractSystemTokenFromLogs(logs: string[]): string {
  const tokenLog = logs.find((line) => line.includes('System Admin Token minted:'))
  if (!tokenLog) {
    throw new Error('Failed to find system token in auth service logs')
  }
  return tokenLog.split('System Admin Token minted:')[1].trim()
}
