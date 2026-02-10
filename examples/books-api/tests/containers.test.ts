import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'path'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'

const isDockerRunning = () => {
  try {
    const result = Bun.spawnSync(['docker', 'info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping container tests: Docker is not running')
}

describe.skipIf(skipTests)('Example GraphQL Servers', () => {
  // Increase timeout for image build
  const TIMEOUT = 120000

  describe('Books Service', () => {
    let startedContainer: StartedTestContainer

    beforeAll(async () => {
      // Build and start the container
      // context is repository root
      const repoRoot = path.resolve(__dirname, '../../..')

      const imageName = 'books-service:test'
      const dockerfile = 'examples/books-api/Dockerfile'

      // Workaround for Bun incompatibility with testcontainers' build strategy.
      // GenericContainer.fromDockerfile() uses 'tar-stream' which fails in Bun with:
      // "TypeError: The 'sourceEnd' argument must be of type number. Received undefined"
      // This is likely due to differences in Buffer/Stream implementation in Bun vs Node.
      // We manually build the image using the docker CLI instead.
      console.log('Building books-api image...')
      const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
        cwd: repoRoot,
        stdout: 'ignore',
        stderr: 'inherit',
      })
      await proc.exited

      const container = await new GenericContainer(imageName)
      startedContainer = await container
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }, TIMEOUT)

    afterAll(async () => {
      if (startedContainer) await startedContainer.stop()
    })

    it(
      'should serve books',
      async () => {
        const port = startedContainer.getMappedPort(8080)
        const host = startedContainer.getHost()
        const url = `http://${host}:${port}/graphql`

        const query = `
                query {
                    books {
                        title
                        author
                    }
                }
            `

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        })

        const result = await response.json()
        expect(result.data).toBeDefined()
        expect(result.data.books).toBeInstanceOf(Array)
        expect(result.data.books[0]).toHaveProperty('title', 'The Lord of the Rings')
      },
      TIMEOUT
    )
  })

  describe('Movies Service', () => {
    let startedContainer: StartedTestContainer

    beforeAll(async () => {
      const repoRoot = path.resolve(__dirname, '../../..')

      const imageName = 'movies-service:test'
      const dockerfile = 'examples/movies-api/Dockerfile'

      console.log('[TEST] [FIXTURE BUILD] Building movies-api image...')
      const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
        cwd: repoRoot,
        stdout: 'ignore',
        stderr: 'inherit',
      })
      await proc.exited

      const container = await new GenericContainer(imageName)
      startedContainer = await container
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp('/health', 8080))
        .start()
    }, TIMEOUT)

    afterAll(async () => {
      if (startedContainer) await startedContainer.stop()
    })

    it(
      'should serve movies',
      async () => {
        const port = startedContainer.getMappedPort(8080)
        const host = startedContainer.getHost()
        const url = `http://${host}:${port}/graphql`

        const query = `
                query {
                    movies {
                        title
                        director
                    }
                }
            `

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        })

        const result = await response.json()
        expect(result.data).toBeDefined()
        expect(result.data.movies).toBeInstanceOf(Array)
        expect(result.data.movies[0]).toHaveProperty('title')
      },
      TIMEOUT
    )
  })
})
