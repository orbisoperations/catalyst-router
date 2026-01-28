import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { StartedTestContainer, StartedNetwork } from 'testcontainers'
import { GenericContainer, Network, Wait } from 'testcontainers'
import { resolve } from 'path'

// Increase timeout for builds
const TIMEOUT = 180_000

describe('CLI E2E with Containers', () => {
  let network: StartedNetwork
  let gatewayContainer: StartedTestContainer
  let orchestratorContainer: StartedTestContainer
  let booksContainer: StartedTestContainer
  let moviesContainer: StartedTestContainer

  let gatewayPort: number
  let orchestratorPort: number
  let booksUri: string
  let moviesUri: string

  const repoRoot = resolve(__dirname, '../../..')
  const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED

  async function runCli(args: string[]) {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
      cwd: resolve(repoRoot, 'packages/cli'),
      env: {
        ...process.env,
        CATALYST_ORCHESTRATOR_URL: process.env.CATALYST_ORCHESTRATOR_URL,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    return {
      stdout,
      stderr,
      exitCode: proc.exitCode,
      success: proc.exitCode === 0,
    }
  }

  beforeAll(async () => {
    if (skipTests) return
    network = await new Network().start()

    console.log('Building Docker images...')

    const buildBooks = async () => {
      await Bun.spawn(
        [
          'podman',
          'build',
          '-t',
          'books-service:test',
          '-f',
          'packages/examples/Dockerfile.books',
          '.',
        ],
        {
          cwd: repoRoot,
          stdout: 'ignore',
          stderr: 'inherit',
        }
      ).exited
    }

    const buildMovies = async () => {
      await Bun.spawn(
        [
          'podman',
          'build',
          '-t',
          'movies-service:test',
          '-f',
          'packages/examples/Dockerfile.movies',
          '.',
        ],
        {
          cwd: repoRoot,
          stdout: 'ignore',
          stderr: 'inherit',
        }
      ).exited
    }

    const buildGateway = async () => {
      await Bun.spawn(
        ['podman', 'build', '-t', 'gateway-service:test', '-f', 'packages/gateway/Dockerfile', '.'],
        {
          cwd: repoRoot,
          stdout: 'ignore',
          stderr: 'inherit',
        }
      ).exited
    }

    const buildOrchestrator = async () => {
      await Bun.spawn(
        [
          'podman',
          'build',
          '-t',
          'orchestrator-service:test',
          '-f',
          'packages/orchestrator/Dockerfile',
          '.',
        ],
        {
          cwd: repoRoot,
          stdout: 'ignore',
          stderr: 'inherit',
        }
      ).exited
    }

    await Promise.all([buildBooks(), buildMovies(), buildGateway(), buildOrchestrator()])
    console.log('Docker images built successfully.')

    console.log('Starting Containers...')

    booksContainer = await new GenericContainer('books-service:test')
      .withExposedPorts(8080)
      .withNetwork(network)
      .withNetworkAliases('books')
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forHttp('/health', 8080))
      .start()

    booksUri = 'http://books:8080/graphql'

    moviesContainer = await new GenericContainer('movies-service:test')
      .withExposedPorts(8080)
      .withNetwork(network)
      .withNetworkAliases('movies')
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forHttp('/health', 8080))
      .start()

    moviesUri = 'http://movies:8080/graphql'

    gatewayContainer = await new GenericContainer('gateway-service:test')
      .withExposedPorts(4000)
      .withNetwork(network)
      .withNetworkAliases('gateway')
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forHttp('/', 4000))
      .start()

    gatewayPort = gatewayContainer.getMappedPort(4000)
    console.log(`Gateway port: ${gatewayPort}`)

    orchestratorContainer = await new GenericContainer('orchestrator-service:test')
      .withExposedPorts(3000)
      .withNetwork(network)
      .withNetworkAliases('orchestrator')
      .withEnvironment({
        CATALYST_GQL_GATEWAY_ENDPOINT: 'ws://gateway:4000/api',
        PORT: '3000',
      })
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start()

    orchestratorPort = orchestratorContainer.getMappedPort(3000)
    process.env.CATALYST_ORCHESTRATOR_URL = `ws://localhost:${orchestratorPort}/rpc`
  }, TIMEOUT)

  afterAll(async () => {
    if (skipTests) return
    console.log('Teardown: Stopping containers...')
    if (orchestratorContainer) await orchestratorContainer.stop()
    if (gatewayContainer) await gatewayContainer.stop()
    if (booksContainer) await booksContainer.stop()
    if (moviesContainer) await moviesContainer.stop()

    if (network) {
      console.log('Teardown: Stopping network...')
      await network.stop()
    }
    console.log('Teardown: Complete.')
  })

  it('should add services via CLI and reflect in list', async () => {
    if (skipTests) return
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait for server warmup

    const runCliExpectSuccess = async (args: string[]) => {
      const res = await runCli(args)
      if (!res.success) {
        console.error(
          `CLI Failure [${args.join(' ')}]:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`
        )
      }
      expect(res.success).toBe(true)
      return res
    }

    // 1. Initial State: Empty
    console.log('--- Step 1: List Empty ---')
    const listRes1 = await runCliExpectSuccess(['service', 'list'])
    expect(listRes1.stdout).toContain('No services found')

    // 2. Add Books
    console.log('--- Step 2: Add Books ---')
    const addRes1 = await runCliExpectSuccess(['service', 'add', 'books', booksUri])
    expect(addRes1.stdout).toContain("Service 'books' added successfully")

    // 3. Verify List has Books
    console.log('--- Step 3: Verify Books ---')
    const listRes2 = await runCliExpectSuccess(['service', 'list'])
    expect(listRes2.stdout).toContain('books')
    expect(listRes2.stdout).toContain(booksUri)

    // 4. Add Movies
    console.log('--- Step 4: Add Movies ---')
    const addRes2 = await runCliExpectSuccess(['service', 'add', 'movies', moviesUri])
    expect(addRes2.stdout).toContain("Service 'movies' added successfully")

    // 5. Verify List has Both
    console.log('--- Step 5: Verify Both ---')
    const listRes3 = await runCliExpectSuccess(['service', 'list'])
    expect(listRes3.stdout).toContain('books')
    expect(listRes3.stdout).toContain('movies')

    // 6. Verify Metrics
    console.log('--- Step 6: Verify Metrics ---')
    const _metricsRes = await runCliExpectSuccess(['metrics'])
    // Metrics output should show something
  }, 30_000)
})
