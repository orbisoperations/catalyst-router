import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { StartedTestContainer, StartedNetwork } from 'testcontainers'
import { GenericContainer, Wait, Network } from 'testcontainers'
import path from 'path'
import { newWebSocketRpcSession } from 'capnweb'

const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED

describe.skipIf(skipTests)('Gateway Container Integration', () => {
  const TIMEOUT = 180000 // 3 minutes for builds
  // Containers
  let booksContainer: StartedTestContainer
  let moviesContainer: StartedTestContainer
  let gatewayContainer: StartedTestContainer
  let network: StartedNetwork

  // Gateway Access
  let gatewayPort: number
  let rpcClient: { updateConfig(config: unknown): Promise<{ success: boolean }> } | null = null
  let ws: WebSocket
  const repoRoot = path.resolve(__dirname, '../../../..')

  beforeAll(async () => {
    network = await new Network().start()

    // 1. Build & Start Books (Background)
    const startBooks = async () => {
      const image = await GenericContainer.fromDockerfile(
        repoRoot,
        'examples/books-api/Dockerfile'
      ).build()

      booksContainer = await image
        .withNetwork(network)
        .withNetworkAliases('books')
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }

    // 2. Build & Start Movies (Background)
    const startMovies = async () => {
      const image = await GenericContainer.fromDockerfile(
        repoRoot,
        'examples/movies-api/Dockerfile'
      ).build()

      moviesContainer = await image
        .withNetwork(network)
        .withNetworkAliases('movies')
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }

    // 3. Build & Start Gateway (Background)
    const startGateway = async () => {
      const image = await GenericContainer.fromDockerfile(
        repoRoot,
        'apps/gateway/Dockerfile'
      ).build()

      gatewayContainer = await image
        .withNetwork(network)
        .withExposedPorts(4000)
        .withWaitStrategy(Wait.forHttp('/', 4000))
        .start()

      gatewayPort = gatewayContainer.getMappedPort(4000)
    }

    // Run builds in parallel to save time
    await Promise.all([startBooks(), startMovies(), startGateway()])
  }, TIMEOUT)

  afterAll(async () => {
    if (ws) ws.close()
    if (booksContainer) await booksContainer.stop()
    if (moviesContainer) await moviesContainer.stop()
    if (gatewayContainer) await gatewayContainer.stop()
    if (network) await network.stop()
  })

  const getRpcClient = async () => {
    if (rpcClient) return rpcClient
    const url = `ws://localhost:${gatewayPort}/api`
    ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e: Event) => reject(e))
    })
    rpcClient = newWebSocketRpcSession(ws as unknown as WebSocket) as unknown as {
      updateConfig(config: unknown): Promise<{ success: boolean }>
    }
    return rpcClient
  }

  const queryGateway = async (query: string) => {
    const res = await fetch(`http://localhost:${gatewayPort}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    return res.json()
  }

  it('should be in initial state (waiting for config)', async () => {
    // The current implementation might return 404 or empty schema if no config.
    // Based on previous tests, it might just have an empty schema or basic query.
    // Let's assume the status query or just introspection works but returns nothing useful yet.
    // Alternatively, the health check passed, so server is up.

    // If we query for something that doesn't exist, it should error.
    const result = await queryGateway('{ books { title } }')
    expect(result.errors).toBeDefined()
  })

  it('should add Books service successfully', async () => {
    const client = await getRpcClient()
    const config = {
      services: [
        // Use the Docker network alias 'books'
        { name: 'books', url: 'http://books:8080/graphql' },
      ],
    }

    const update = await client.updateConfig(config)
    expect(update).toEqual({ success: true })

    // Query Books
    const result = await queryGateway('{ books { title } }')
    expect(result.data.books).toBeDefined()
    expect(result.data.books.length).toBeGreaterThan(0)

    // Query Movies (Should Fail)
    const failResult = await queryGateway('{ movies { title } }')
    expect(failResult.errors).toBeDefined()
  })

  it('should add Movies service (incremental)', async () => {
    const client = await getRpcClient()
    const config = {
      services: [
        { name: 'books', url: 'http://books:8080/graphql' },
        { name: 'movies', url: 'http://movies:8080/graphql' },
      ],
    }

    const update = await client.updateConfig(config)
    expect(update).toEqual({ success: true })

    // Query Both
    const result = await queryGateway(`
            query {
                books { title }
                movies { title }
            }
        `)

    expect(result.data.books).toBeDefined()
    expect(result.data.movies).toBeDefined()
    expect(result.data.books.length).toBeGreaterThan(0)
    expect(result.data.movies.length).toBeGreaterThan(0)
  })

  it('should reset to empty config', async () => {
    const client = await getRpcClient()
    // Sending empty services list
    // Note: The schema might complain if 'services' is required to be non-empty or if schema stitching fails with 0 subschemas.
    // But let's try.
    const config = { services: [] }

    const update = await client.updateConfig(config)

    // If the implementation allows clearing the schema (no services), it sets default schema or stays as is?
    // Checking `GatewayGraphqlServer.reload`:
    // if (services.length === 0) -> It might fail stitching if stitchSchemas expects at least one?
    // Actually `stitchSchemas({ subschemas: [] })` is valid but creates empty schema.

    expect(update).toEqual({ success: true })

    // Querying books should now fail
    const result = await queryGateway('{ books { title } }')
    expect(result.errors).toBeDefined()
  })
})
