import { spawnSync } from 'node:child_process'
import path from 'path'
import { IMAGE_DOCKERFILES } from './docker-images.js'

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'

/**
 * Build Docker images for container tests.
 *
 * Skips images that already exist (unless force=true). This is safe because
 * turbo's `test:container` task has `cache: false`, so the globalSetup
 * runs on every invocation — but image caching avoids redundant rebuilds
 * when running multiple packages sequentially.
 */
export function buildImages(tags: string[], repoRoot?: string): void {
  const root = repoRoot ?? path.resolve(import.meta.dirname, '..')

  for (const tag of tags) {
    const dockerfile = IMAGE_DOCKERFILES[tag]
    if (!dockerfile) {
      throw new Error(`Unknown image tag: ${tag}. Check tests/docker-images.ts`)
    }

    // Check if image already exists
    const check = spawnSync(CONTAINER_RUNTIME, ['image', 'inspect', tag], {
      stdio: 'ignore',
    })
    if (check.status === 0) {
      console.log(`[globalSetup] Using existing image: ${tag}`)
      continue
    }

    console.log(`[globalSetup] Building image: ${tag} (${dockerfile})...`)
    const build = spawnSync(CONTAINER_RUNTIME, ['build', '-f', dockerfile, '-t', tag, '.'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (build.status !== 0) {
      throw new Error(`Docker build failed for ${tag} (${dockerfile})`)
    }
  }
}
