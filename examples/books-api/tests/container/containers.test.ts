import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import { TEST_IMAGES } from '../../../../tests/docker-images.js'

const isDockerRunning = () => {
  try {
    const result = spawnSync('docker', ['info'])
    return result.status === 0
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
      startedContainer = await new GenericContainer(TEST_IMAGES.booksApi)
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
      startedContainer = await new GenericContainer(TEST_IMAGES.moviesApi)
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
