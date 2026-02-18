import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Hono } from 'hono'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import path from 'path'
import type { GatewayGraphqlServer } from '../src/graphql/server.ts'
import { createGatewayHandler } from '../src/graphql/server.ts'

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const skipTests = !process.env.CATALYST_CONTAINER_TESTS_ENABLED

describe.skipIf(skipTests)('Gateway Integration', () => {
  const TIMEOUT = 120000
  let booksContainer: StartedTestContainer
  let moviesContainer: StartedTestContainer
  let gatewayServer: GatewayGraphqlServer
  let gatewayApp: Hono

  beforeAll(async () => {
    console.log('Starting Gateway Integration Test')
    const repoRoot = path.resolve(__dirname, '../../..')
    console.log('Repo root:', repoRoot)

    // 1. Start Books Service
    {
      console.log('Starting Books Service')
      const imageName = 'books-service:test'
      const dockerfile = 'examples/books-api/Dockerfile'
      // Workaround for Bun tar-stream issue
      const proc = Bun.spawn([CONTAINER_RUNTIME, 'build', '-t', imageName, '-f', dockerfile, '.'], {
        cwd: repoRoot,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await proc.exited

      const container = new GenericContainer(imageName)
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
      booksContainer = await container.start()
    }

    // 2. Start Movies Service
    {
      console.log('Starting Movies Service')
      const imageName = 'movies-service:test'
      const dockerfile = 'examples/movies-api/Dockerfile'
      // Workaround for Bun tar-stream issue
      const proc = Bun.spawn([CONTAINER_RUNTIME, 'build', '-t', imageName, '-f', dockerfile, '.'], {
        cwd: repoRoot,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await proc.exited

      const container = new GenericContainer(imageName)
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
      moviesContainer = await container.start()
    }

    // 3. Start Gateway (in-process)
    // We use createGatewayHandler to get the app and the server instance
    const result = createGatewayHandler()
    gatewayApp = result.app as unknown as Hono
    gatewayServer = result.server
  }, TIMEOUT)

  afterAll(async () => {
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

      const updateResult = await gatewayServer.reload(config)
      expect(updateResult.success).toBe(true)

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

      const response = await gatewayApp.request('http://localhost/graphql', {
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
