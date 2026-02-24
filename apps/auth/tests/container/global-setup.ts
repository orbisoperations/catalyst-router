import { buildImages } from '../../../../tests/build-images.js'
import { TEST_IMAGES } from '../../../../tests/docker-images.js'

export function setup(): void {
  buildImages([TEST_IMAGES.auth])
}
