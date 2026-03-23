import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import { resolve } from 'path'
import { newWebSocketRpcSession } from 'capnweb'

const isDockerRunning = () => {
  try {
    return spawnSync('docker', ['info']).status === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping auth container tests: Docker not running')
}

const TIMEOUT = 300_000

describe.skipIf(skipTests)('Auth Service Container', () => {
  let container: StartedTestContainer
  let port: number
  let systemToken: string

  const repoRoot = resolve(__dirname, '../../../')

  beforeAll(async () => {
    console.log('Building Docker image from', repoRoot)

    const image = await GenericContainer.fromDockerfile(repoRoot, 'apps/auth/Dockerfile').build()

    const authLogs: string[] = []
    container = await image
      .withExposedPorts(5000)
      .withEnvironment({
        CATALYST_NODE_ID: 'auth-test',
        CATALYST_AUTH_KEYS_DB: ':memory:',
        CATALYST_AUTH_TOKENS_DB: ':memory:',
      })
      .withWaitStrategy(Wait.forLogMessage('System Admin Token minted:'))
      .withLogConsumer((stream: NodeJS.ReadableStream) => {
        stream.on('data', (chunk: Buffer) => {
          authLogs.push(chunk.toString())
        })
      })
      .start()

    port = container.getMappedPort(5000)
    console.log(`Container started on port ${port}`)

    for (let i = 0; i < 20; i++) {
      const match = authLogs.join('').match(/System Admin Token minted: (eyJ[^\s]+)/)
      if (match) {
        systemToken = match[1]
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!systemToken) {
      throw new Error('Failed to extract system token from auth logs')
    }
  }, TIMEOUT)

  afterAll(async () => {
    await container?.stop()
  })

  it(
    'should mint, verify, and list tokens via RPC',
    async () => {
      const authUrl = `ws://${container.getHost()}:${port}/rpc`
      const client = newWebSocketRpcSession(authUrl) as unknown as {
        tokens(token: string): Promise<{
          create(req: {
            subject: string
            entity: { id: string; name: string; type: string }
            principal: string
            expiresIn: string
          }): Promise<string>
          list(req: Record<string, unknown>): Promise<{ jti: string; sub?: string }[]>
        }>
        validation(token: string): Promise<{
          validate(req: { token: string }): Promise<{
            valid: boolean
            payload?: { sub: string }
          }>
        }>
      }

      const tokensApi = await client.tokens(systemToken)
      const newToken = await tokensApi.create({
        subject: 'test-user',
        entity: { id: 'test-user', name: 'Test User', type: 'user' },
        principal: 'CATALYST::USER',
        expiresIn: '1h',
      })
      expect(typeof newToken).toBe('string')
      expect(newToken).toMatch(/^eyJ/)

      const validationApi = await client.validation(systemToken)
      const verifyResult = await validationApi.validate({ token: newToken })
      expect(verifyResult.valid).toBe(true)
      expect(verifyResult.payload?.sub).toBe('test-user')

      const tokensList = await tokensApi.list({})
      expect(tokensList.length).toBeGreaterThan(0)
    },
    TIMEOUT
  )
})
