import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import { newWebSocketRpcSession } from 'capnweb'
import path from 'path'

const isDockerRunning = () => {
  try {
    return spawnSync('docker', ['info']).status === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping gateway integration test: Docker is not running')
}

describe.skipIf(skipTests)('Gateway Integration', () => {
  const TIMEOUT = 300000
  const debugGatewayLogs = Boolean(process.env.DEBUG_GATEWAY_TESTS)
  let booksContainer: StartedTestContainer
  let moviesContainer: StartedTestContainer
  let gatewayProcess: ChildProcess
  let gatewayPort: number
  let gatewayLogs = ''

  const connectRpcClient = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (event) => reject(event))
    })

    return {
      ws,
      client: newWebSocketRpcSession(ws as unknown as WebSocket) as unknown as {
        updateConfig(config: unknown): Promise<{ success: boolean; error?: string }>
      },
    }
  }

  const startGatewayProcess = async (repoRoot: string) => {
    const gatewayCwd = path.join(repoRoot, 'apps/gateway')

    return new Promise<number>((resolve, reject) => {
      let settled = false
      let stdout = ''
      let stderr = ''

      gatewayProcess = spawn('pnpm', ['exec', 'tsx', 'tests/helpers/gateway-process.ts'], {
        cwd: gatewayCwd,
        env: {
          ...process.env,
          CATALYST_NODE_ID: 'gateway-test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const rejectWithContext = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }

      gatewayProcess.on('error', (error) => {
        rejectWithContext(`Gateway process failed to start: ${String(error)}`)
      })

      gatewayProcess.on('exit', (code, signal) => {
        if (!settled) {
          rejectWithContext(
            `Gateway process exited before startup (code=${code}, signal=${signal})`
          )
        }
      })

      gatewayProcess.stdout!.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        stdout += text
        gatewayLogs += text
        if (debugGatewayLogs) {
          process.stdout.write(`[gateway] ${text}`)
        }

        const match = stdout.match(/GATEWAY_TEST_PORT=(\d+)/)
        if (match && !settled) {
          settled = true
          resolve(Number(match[1]))
        }
      })

      gatewayProcess.stderr!.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        stderr += text
        gatewayLogs += text
        if (debugGatewayLogs) {
          process.stderr.write(`[gateway:err] ${text}`)
        }
      })
    })
  }

  const stopGatewayProcess = async () => {
    if (!gatewayProcess || gatewayProcess.killed || gatewayProcess.exitCode !== null) {
      return
    }

    gatewayProcess.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        gatewayProcess.kill('SIGKILL')
      }, 5000)

      gatewayProcess.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  beforeAll(async () => {
    console.log('Starting Gateway Integration Test')
    const repoRoot = path.resolve(__dirname, '../../..')
    console.log('Repo root:', repoRoot)
    gatewayLogs = ''

    // 1. Start Books Service
    {
      console.log('Starting Books Service')
      const dockerfile = 'examples/books-api/Dockerfile'
      const image = await GenericContainer.fromDockerfile(repoRoot, dockerfile).build()
      booksContainer = await image
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }

    // 2. Start Movies Service
    {
      console.log('Starting Movies Service')
      const dockerfile = 'examples/movies-api/Dockerfile'
      const image = await GenericContainer.fromDockerfile(repoRoot, dockerfile).build()
      moviesContainer = await image
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }

    console.log('Starting Gateway Process')
    gatewayPort = await startGatewayProcess(repoRoot)
  }, TIMEOUT)

  afterAll(async () => {
    await stopGatewayProcess()
    if (booksContainer) await booksContainer.stop()
    if (moviesContainer) await moviesContainer.stop()
  })

  it(
    'should federate books and movies',
    async () => {
      const booksPort = booksContainer.getMappedPort(8080)
      const booksHost = booksContainer.getHost()
      const moviesPort = moviesContainer.getMappedPort(8080)
      const moviesHost = moviesContainer.getHost()

      // 4. Configure Gateway with dynamic ports
      const config = {
        services: [
          {
            name: 'books',
            url: `http://${booksHost}:${booksPort}/graphql`,
          },
          {
            name: 'movies',
            url: `http://${moviesHost}:${moviesPort}/graphql`,
          },
        ],
      }

      const { ws, client } = await connectRpcClient()
      const updateResult = await client.updateConfig(config)
      ws.close()

      if (!updateResult.success) {
        throw new Error(
          `Gateway config update failed: ${updateResult.error ?? 'unknown error'}\nGateway logs:\n${gatewayLogs}`
        )
      }

      // 5. Query Gateway
      const query = `
            query {
                books {
                    title
                    author
                }
                movies {
                    title
                    director
                }
            }
        `

      const response = await fetch(`http://127.0.0.1:${gatewayPort}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      const result = await response.json()

      expect(result.data).toEqual({
        books: [
          { title: 'The Lord of the Rings', author: 'J.R.R. Tolkien' },
          { title: 'Pride and Prejudice', author: 'Jane Austen' },
          { title: 'The Hobbit', author: 'J.R.R. Tolkien' },
        ],
        movies: [
          { title: 'The Lord of the Rings: The Fellowship of the Ring', director: 'Peter Jackson' },
          { title: 'Super Mario Bros.', director: 'Rocky Morton, Annabel Jankel' },
          { title: 'Pride & Prejudice', director: 'Joe Wright' },
        ],
      })
    },
    TIMEOUT
  )
})
