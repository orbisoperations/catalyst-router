import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import path from 'path'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'

const isDockerRunning = () => {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
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

      const dockerfile = 'examples/books-api/Dockerfile'

      console.log('Building books-api image...')
      const image = await GenericContainer.fromDockerfile(repoRoot, dockerfile).build(
        'books-service:test',
        { deleteOnExit: false }
      )

      startedContainer = await image
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

      const dockerfile = 'examples/movies-api/Dockerfile'

      console.log('Building movies-api image...')
      const image = await GenericContainer.fromDockerfile(repoRoot, dockerfile).build(
        'movies-service:test',
        { deleteOnExit: false }
      )

      startedContainer = await image
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
