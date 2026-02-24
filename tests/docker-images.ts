/**
 * Standardized Docker image tags for container tests.
 *
 * All container tests share the same image tags to avoid redundant builds.
 * The globalSetup in each package builds only the images it needs.
 */
export const TEST_IMAGES = {
  auth: 'catalyst-auth:test',
  orchestrator: 'catalyst-orchestrator:test',
  envoy: 'catalyst-envoy:test',
  envoyProxy: 'catalyst-envoy-proxy:test',
  gateway: 'catalyst-gateway:test',
  booksApi: 'catalyst-books:test',
  moviesApi: 'catalyst-movies:test',
} as const

/**
 * Maps image tags to their Dockerfile paths (relative to repo root).
 */
export const IMAGE_DOCKERFILES: Record<string, string> = {
  [TEST_IMAGES.auth]: 'apps/auth/Dockerfile',
  [TEST_IMAGES.orchestrator]: 'apps/orchestrator/Dockerfile',
  [TEST_IMAGES.envoy]: 'apps/envoy/Dockerfile',
  [TEST_IMAGES.envoyProxy]: 'apps/envoy/Dockerfile.envoy-proxy',
  [TEST_IMAGES.gateway]: 'apps/gateway/Dockerfile',
  [TEST_IMAGES.booksApi]: 'examples/books-api/Dockerfile',
  [TEST_IMAGES.moviesApi]: 'examples/movies-api/Dockerfile',
}
