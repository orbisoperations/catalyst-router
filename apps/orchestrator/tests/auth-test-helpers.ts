import { Principal } from '@catalyst/authorization'
import type { StartedTestContainer, StartedNetwork } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import type { Readable } from 'node:stream'
import { newWebSocketRpcSession } from 'capnweb'

export interface AuthServiceContext {
  container: StartedTestContainer
  systemToken: string
  endpoint: string
}

interface AuthServiceApi {
  tokens(token: string): Promise<
    | {
        create(request: {
          subject: string
          entity: {
            id: string
            name: string
            type: 'user' | 'service'
            trustedDomains?: string[]
            trustedNodes?: string[]
          }
          principal: string
          sans?: string[]
          expiresIn?: string
        }): Promise<string>
        revoke(request: { jti?: string; san?: string }): Promise<void>
        list(request: { certificateFingerprint?: string; san?: string }): Promise<unknown[]>
      }
    | { error: string }
  >
}

/**
 * Starts an auth service container and extracts the system token.
 *
 * @param network - Docker network to attach to
 * @param alias - Network alias for the auth service
 * @param authImage - Docker image name for auth service
 * @param bootstrapToken - Bootstrap token for auth service
 * @param port - Port to expose (default: 5000)
 * @returns Auth service context with container, system token, and endpoint
 */
export async function startAuthService(
  network: StartedNetwork,
  alias: string,
  authImage: string,
  bootstrapToken = 'test-bootstrap-token',
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
      CATALYST_NODE_ID: alias, // Auth service uses this as JWT issuer
      CATALYST_PEERING_ENDPOINT: `ws://${alias}:${port}/rpc`, // Required by loadDefaultConfig
      CATALYST_BOOTSTRAP_TOKEN: bootstrapToken,
      CATALYST_AUTH_KEYS_DB: ':memory:', // Use in-memory DB for container tests
      CATALYST_AUTH_TOKENS_DB: ':memory:', // Use in-memory DB for container tests
    })
    .withWaitStrategy(Wait.forLogMessage('System Admin Token minted:'))
    .withLogConsumer((stream: Readable) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString()
        authLogs.push(text)
        process.stdout.write(`[${alias}] ${text}`)
      })
    })
    .start()

  console.log(`Auth service ${alias} started, extracting system token...`)

  // Wait for log to be captured (race condition between wait strategy and log consumer)
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

/**
 * Mints a peer token from an auth service for a specific peer node.
 *
 * This is used for cert-bound token authentication where Auth-A mints a token
 * for Orch-B to use when connecting to Orch-A.
 *
 * @param authEndpoint - WebSocket endpoint of the auth service
 * @param systemToken - System admin token for the auth service
 * @param peerName - Name of the peer node that will use this token
 * @param domain - Organization domain the peer token should be valid for
 * @returns Peer token string
 */
export async function mintPeerToken(
  authEndpoint: string,
  systemToken: string,
  peerName: string,
  domain: string
): Promise<string> {
  console.log(`Minting peer token for ${peerName} from ${authEndpoint}...`)
  const authClient = newWebSocketRpcSession<AuthServiceApi>(authEndpoint)
  const tokensApi = await authClient.tokens(systemToken)

  if ('error' in tokensApi) {
    throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
  }

  const peerToken = await tokensApi.create({
    subject: peerName,
    entity: {
      id: peerName,
      name: peerName,
      type: 'service',
      trustedDomains: domain ? [domain] : [],
      trustedNodes: [], // Empty = trust all nodes
    },
    principal: Principal.NODE,
    expiresIn: '1h',
  })

  console.log(`[ok] Peer token minted for ${peerName}: ${peerToken.substring(0, 20)}...`)
  return peerToken
}
