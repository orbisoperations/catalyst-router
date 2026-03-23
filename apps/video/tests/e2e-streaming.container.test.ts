import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import path from 'path'

/**
 * E2E test: video service starts with MediaMTX and serves lifecycle hooks.
 *
 * Verifies:
 * - SC-001: Video service container starts with MediaMTX sidecar
 * - Lifecycle hooks (ready/not-ready) accept valid payloads
 * - MediaMTX Control API is reachable inside the container
 *
 * Requires Docker. Skipped if Docker is not available.
 */

const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'
const repoRoot = path.resolve(__dirname, '../../..')
const videoImage = 'catalyst-video:streaming-e2e'

const SERVICE_PORT = 3000
const RTSP_PORT = 8554
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
  console.warn('Skipping E2E streaming tests: Docker not running')
}

describe.skipIf(skipTests)('E2E: video service with MediaMTX', () => {
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
      .withExposedPorts(SERVICE_PORT, RTSP_PORT)
      .withEnvironment({
        PORT: String(SERVICE_PORT),
        CATALYST_NODE_ID: 'video-streaming-test.local',
        CATALYST_VIDEO_ENABLED: 'true',
        CATALYST_VIDEO_RTSP_PORT: String(RTSP_PORT),
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
    console.log(
      `[setup] Video service ready (http=:${port}, rtsp=:${container.getMappedPort(RTSP_PORT)})`
    )
  }, SETUP_TIMEOUT)

  afterAll(async () => {
    await container?.stop().catch(() => {})
  }, SETUP_TIMEOUT)

  it(
    'health endpoint returns ok with video service registered',
    async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.ok).toBe(true)

      const body = (await res.json()) as { status: string; services?: string[] }
      expect(body.status).toBe('ok')
      expect(body.services).toContain('video')
    },
    TEST_TIMEOUT
  )

  it(
    'ready hook accepts valid publish payload',
    async () => {
      const res = await fetch(`${baseUrl}/video-stream/hooks/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'test-cam-1',
          sourceType: 'rtspSession',
          sourceId: 'test-session-1',
        }),
      })
      expect(res.ok).toBe(true)

      const body = (await res.json()) as { success: boolean; route?: string }
      expect(body.success).toBe(true)
      expect(body.route).toBe('test-cam-1')
    },
    TEST_TIMEOUT
  )

  it(
    'not-ready hook accepts valid withdrawal payload',
    async () => {
      // First register a stream so there's something to withdraw
      await fetch(`${baseUrl}/video-stream/hooks/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'test-cam-withdraw',
          sourceType: 'rtspSession',
          sourceId: 'test-session-2',
        }),
      })

      const res = await fetch(`${baseUrl}/video-stream/hooks/not-ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'test-cam-withdraw',
          sourceType: 'rtspSession',
          sourceId: 'test-session-2',
        }),
      })
      expect(res.ok).toBe(true)

      const body = (await res.json()) as { success: boolean }
      expect(body.success).toBe(true)
    },
    TEST_TIMEOUT
  )

  it(
    'ready hook rejects malformed payload',
    async () => {
      const res = await fetch(`${baseUrl}/video-stream/hooks/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: true }),
      })
      expect(res.status).toBe(400)
    },
    TEST_TIMEOUT
  )

  it(
    'RTSP port is exposed and accepting connections',
    async () => {
      const rtspPort = container.getMappedPort(RTSP_PORT)
      // Verify the RTSP port is open by attempting a TCP connection.
      // MediaMTX listens on this port for RTSP clients.
      const connected = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: 'localhost', port: rtspPort }, () => {
          socket.destroy()
          resolve(true)
        })
        socket.on('error', () => resolve(false))
        socket.setTimeout(5000, () => {
          socket.destroy()
          resolve(false)
        })
      })
      expect(connected).toBe(true)
    },
    TEST_TIMEOUT
  )
})
