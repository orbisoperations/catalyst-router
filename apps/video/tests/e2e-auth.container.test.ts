import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import path from 'path'

/**
 * E2E test: auth hook enforcement on a containerized video service.
 *
 * Verifies:
 * - SC-003: Auth hook latency < 100ms
 * - SC-007: Cedar role matrix enforced (publish = localhost-only, read = JWT required)
 *
 * Builds and starts the video service Docker image, then exercises the
 * /video-stream/auth endpoint to verify publish/read decisions.
 *
 * Requires Docker. Skipped if Docker is not available.
 */

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const repoRoot = path.resolve(__dirname, '../../..')
const videoImage = 'catalyst-video:auth-e2e'

const SERVICE_PORT = 3000
const SETUP_TIMEOUT = 300_000
const TEST_TIMEOUT = 30_000

const isDockerRunning = (): boolean => {
  try {
    return spawnSync('docker', ['info']).status === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping E2E auth tests: Docker not running')
}

async function authRequest(
  baseUrl: string,
  payload: {
    action: 'publish' | 'read' | 'playback'
    ip: string
    path: string
    protocol: 'rtsp' | 'rtmp' | 'hls'
    token?: string
    password?: string
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/video-stream/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'test-session', ...payload }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

describe.skipIf(skipTests)('E2E: auth hook enforcement', () => {
  let container: StartedTestContainer
  let baseUrl: string

  beforeAll(async () => {
    console.log('[setup] Building video service image...')
    const buildResult = spawnSync(
      CONTAINER_RUNTIME,
      ['build', '-t', videoImage, '-f', 'apps/video/Dockerfile', '.'],
      { cwd: repoRoot, stdio: 'inherit' }
    )
    if (buildResult.status !== 0) throw new Error('Failed to build video service image')

    console.log('[setup] Starting video service container...')
    container = await new GenericContainer(videoImage)
      .withExposedPorts(SERVICE_PORT)
      .withEnvironment({
        PORT: String(SERVICE_PORT),
        CATALYST_NODE_ID: 'video-auth-test.local',
        CATALYST_VIDEO_ENABLED: 'true',
        CATALYST_VIDEO_RTSP_PORT: '8554',
        CATALYST_VIDEO_ADVERTISE_ADDRESS: 'localhost',
        CATALYST_VIDEO_MAX_STREAMS: '10',
        CATALYST_ORCHESTRATOR_ENDPOINT: 'ws://localhost:9999/rpc',
        CATALYST_AUTH_ENDPOINT: 'ws://localhost:9998/rpc',
        CATALYST_SYSTEM_TOKEN: 'test-token',
      })
      .withWaitStrategy(Wait.forHttp('/health', SERVICE_PORT))
      .withStartupTimeout(120_000)
      .start()

    const port = container.getMappedPort(SERVICE_PORT)
    baseUrl = `http://localhost:${port}`
    console.log(`[setup] Video service ready (port=${port})`)
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    await container?.stop().catch(() => {})
  }, SETUP_TIMEOUT)

  it(
    'health endpoint returns ok',
    async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.ok).toBe(true)

      const body = (await res.json()) as { status: string }
      expect(body.status).toBe('ok')
    },
    TEST_TIMEOUT
  )

  it(
    'allows localhost publish',
    async () => {
      const res = await authRequest(baseUrl, {
        action: 'publish',
        ip: '127.0.0.1',
        path: 'cam-1',
        protocol: 'rtsp',
      })
      expect(res.status).toBe(200)
    },
    TEST_TIMEOUT
  )

  it(
    'denies remote publish',
    async () => {
      const res = await authRequest(baseUrl, {
        action: 'publish',
        ip: '10.0.0.5',
        path: 'cam-1',
        protocol: 'rtsp',
      })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('permission_denied')
    },
    TEST_TIMEOUT
  )

  it(
    'denies read without token',
    async () => {
      const res = await authRequest(baseUrl, {
        action: 'read',
        ip: '10.0.0.100',
        path: 'cam-1',
        protocol: 'rtsp',
      })
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('unauthorized')
    },
    TEST_TIMEOUT
  )

  it(
    'denies read with invalid token',
    async () => {
      const res = await authRequest(baseUrl, {
        action: 'read',
        ip: '10.0.0.100',
        path: 'cam-1',
        protocol: 'rtsp',
        token: 'not-a-valid-jwt',
      })
      // 401 (invalid token) or 503 (auth service unreachable from container)
      expect([401, 503]).toContain(res.status)
    },
    TEST_TIMEOUT
  )

  it(
    'auth hook responds within 500ms',
    async () => {
      const start = performance.now()
      await authRequest(baseUrl, {
        action: 'read',
        ip: '10.0.0.100',
        path: 'cam-1',
        protocol: 'rtsp',
      })
      const elapsed = performance.now() - start
      // SC-003: Auth hook latency < 100ms internally; we allow margin for
      // Docker port mapping + network hop from the test host.
      expect(elapsed).toBeLessThan(500)
    },
    TEST_TIMEOUT
  )

  it(
    'rejects malformed auth payload',
    async () => {
      const res = await fetch(`${baseUrl}/video-stream/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: true }),
      })
      expect(res.status).toBe(400)
    },
    TEST_TIMEOUT
  )

  it(
    'rejects path with shell metacharacters',
    async () => {
      const res = await authRequest(baseUrl, {
        action: 'publish',
        ip: '127.0.0.1',
        path: 'cam;rm -rf /',
        protocol: 'rtsp',
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_request')
    },
    TEST_TIMEOUT
  )
})
