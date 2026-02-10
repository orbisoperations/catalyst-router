import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import { createAuthClient } from '../../src/clients/auth-client.js'

const isDockerRunning = () => {
  try {
    const result = Bun.spawnSync(['docker', 'info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning() || !process.env.CATALYST_CONTAINER_TESTS_ENABLED
if (skipTests) {
  console.warn(
    'Skipping token container tests: Docker not running or CATALYST_CONTAINER_TESTS_ENABLED not set'
  )
}

describe.skipIf(skipTests)('Token Commands Container Tests', () => {
  const TIMEOUT = 300000 // 5 minutes
  const authImage = 'catalyst-auth:next-topology-e2e'
  const repoRoot = path.resolve(__dirname, '../../../../')

  let network: StartedNetwork
  let auth: StartedTestContainer
  let systemToken: string

  beforeAll(async () => {
    console.log('Building auth image...')
    const authBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/auth/Dockerfile', '-t', authImage, '.'],
      { cwd: repoRoot }
    )
    if (authBuild.exitCode !== 0) {
      throw new Error('Failed to build auth image')
    }

    // Create network
    network = await new Network().start()

    // Start auth service
    console.log('Starting auth service...')
    auth = await new GenericContainer(authImage)
      .withNetwork(network)
      .withNetworkAliases('auth')
      .withExposedPorts(5000)
      .withEnvironment({
        CATALYST_AUTH_ISSUER: 'catalyst',
        CATALYST_AUTH_KEYS_DB: ':memory:',
        CATALYST_AUTH_TOKENS_DB: ':memory:',
        CATALYST_BOOTSTRAP_TTL: '3600000',
        CATALYST_NODE_ID: 'auth-node',
      })
      .withWaitStrategy(Wait.forLogMessage('Auth service started'))
      .start()

    // Extract system token from logs
    const authLogs = await auth.logs()
    let logsData = ''
    for await (const chunk of authLogs) {
      logsData += chunk.toString()
    }
    const tokenMatch = logsData.match(/System Admin Token minted: (eyJ[^\s]+)/)
    if (!tokenMatch) {
      throw new Error('Failed to extract system token from auth logs')
    }
    systemToken = tokenMatch[1]
    console.log('Extracted system token:', systemToken.substring(0, 20) + '...')
  }, TIMEOUT)

  afterAll(async () => {
    await auth?.stop()
    await network?.stop()
  }, TIMEOUT)

  it(
    'should mint, verify, list, and revoke tokens via client',
    async () => {
      const authUrl = `ws://${auth.getHost()}:${auth.getMappedPort(5000)}/rpc`

      // Create client
      const client = await createAuthClient(authUrl)
      const tokensApi = await client.tokens(systemToken)

      if ('error' in tokensApi) {
        throw new Error(`Failed to get tokens API: ${tokensApi.error}`)
      }

      // Mint token
      const newToken = await tokensApi.create({
        subject: 'test-user',
        entity: {
          id: 'test-user',
          name: 'Test User',
          type: 'user',
          role: 'USER',
        },
        roles: ['USER'],
        expiresIn: '1h',
      })
      expect(typeof newToken).toBe('string')
      expect(newToken).toMatch(/^eyJ/)

      // Verify token
      const validationApi = await client.validation(systemToken)
      if ('error' in validationApi) {
        throw new Error(`Failed to get validation API: ${validationApi.error}`)
      }

      const verifyResult = await validationApi.validate({
        token: newToken,
      })
      expect(verifyResult.valid).toBe(true)
      expect(verifyResult.payload).toBeDefined()
      expect(verifyResult.payload?.sub).toBe('test-user')

      // List tokens
      const tokensList = await tokensApi.list({})
      expect(tokensList.length).toBeGreaterThan(0)
      const mintedToken = tokensList.find((t) => t.sub === 'test-user')
      expect(mintedToken).toBeDefined()

      // Revoke token
      await tokensApi.revoke({
        jti: mintedToken!.jti,
      })

      // Verify token is now invalid (revoked)
      const verifyAfterRevoke = await validationApi.validate({
        token: newToken,
      })
      expect(verifyAfterRevoke.valid).toBe(false)
    },
    TIMEOUT
  )

  it(
    'should handle invalid token verification',
    async () => {
      const authUrl = `ws://${auth.getHost()}:${auth.getMappedPort(5000)}/rpc`

      const client = await createAuthClient(authUrl)
      const validationApi = await client.validation(systemToken)

      if ('error' in validationApi) {
        throw new Error(`Failed to get validation API: ${validationApi.error}`)
      }

      const result = await validationApi.validate({
        token: 'invalid.token.here',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    },
    TIMEOUT
  )
})
