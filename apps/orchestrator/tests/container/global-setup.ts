import { buildImages } from '../../../../tests/build-images.js'
import { TEST_IMAGES } from '../../../../tests/docker-images.js'

export function setup(): void {
  buildImages([
    TEST_IMAGES.auth,
    TEST_IMAGES.orchestrator,
    TEST_IMAGES.gateway,
    TEST_IMAGES.booksApi,
  ])
}
