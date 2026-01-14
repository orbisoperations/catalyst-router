import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { StartedTestContainer } from 'testcontainers'
import { GenericContainer, Wait } from 'testcontainers'
import { resolve } from 'path'
import { execSync } from 'child_process'

// Increase timeout for container build
const TIMEOUT = 180_000
const RUN_CONTAINER_TESTS = process.env.RUN_CONTAINER_TESTS === 'true'

// Skip rebuild if image exists (set REBUILD_IMAGES=true to force rebuild)
const FORCE_REBUILD = process.env.REBUILD_IMAGES === 'true'

function imageExists(imageName: string): boolean {
  try {
    const output = execSync(`podman images -q ${imageName}`, { encoding: 'utf-8' })
    return output.trim().length > 0
  } catch {
    return false
  }
}

function ensureImage(imageName: string, dockerfile: string, buildContext: string): void {
  if (!FORCE_REBUILD && imageExists(imageName)) {
    console.log(`Using existing image: ${imageName}`)
    return
  }

  console.log(`Building image: ${imageName}...`)
  try {
    execSync(`podman build -t ${imageName} -f ${dockerfile} .`, {
      cwd: buildContext,
      stdio: 'inherit',
    })
  } catch (error) {
    // Check if it's a Podman connection error
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('Cannot connect to Podman') || errorMessage.includes('podman')) {
      throw new Error(
        'Podman/Docker is not available. Integration tests require Podman/Docker to be running. Skipping integration tests.'
      )
    }
    throw error
  }
}

if (!RUN_CONTAINER_TESTS) {
  console.warn(
    'Skipping Service Token CLI integration tests (set RUN_CONTAINER_TESTS=true to enable).'
  )
  describe.skip('Service Token CLI Integration', () => {})
} else {
  describe('Service Token CLI Integration', () => {
    let container: StartedTestContainer | null = null
    let port: number
    const buildContext = resolve(__dirname, '../../..')
    let skipTests = false

    beforeAll(
      'setup auth container',
      async () => {
        try {
          const imageName = 'auth-service:test'
          const dockerfile = 'packages/auth/Dockerfile'

          ensureImage(imageName, dockerfile, buildContext)

          console.log('Starting auth service container...')
          container = await new GenericContainer(imageName)
            .withExposedPorts(4020)
            .withEnvironment({
              CATALYST_AUTH_PORT: '4020',
              CATALYST_AUTH_KEYS_DIR: '/tmp/keys',
            })
            .withWaitStrategy(Wait.forHttp('/health', 4020))
            .withStartupTimeout(TIMEOUT)
            .start()

          port = container.getMappedPort(4020)
          console.log(`Auth service started on port ${port}`)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          if (
            errorMessage.includes('Podman') ||
            errorMessage.includes('Docker') ||
            errorMessage.includes('not available')
          ) {
            console.warn('Skipping integration tests: Podman/Docker not available')
            skipTests = true
          } else {
            throw error
          }
        }
      },
      TIMEOUT
    )

    afterAll(async () => {
      if (container) {
        await container.stop()
      }
    })

    async function runCLI(
      args: string[]
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (!container || !port) {
        throw new Error('Container not initialized')
      }
      const cliPath = resolve(__dirname, '../src/index.ts')
      // Use the same bun executable that's running this test
      const bunExecutable = process.execPath || 'bun'
      const env = {
        ...process.env,
        CATALYST_AUTH_ENDPOINT: `ws://localhost:${port}/rpc`,
      }

      try {
        const proc = Bun.spawn([bunExecutable, cliPath, ...args], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        })

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])

        return {
          stdout,
          stderr,
          exitCode: exitCode ?? 0,
        }
      } catch (error) {
        return {
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        }
      }
    }

    it('should generate a basic token', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI(['service-token', 'generate', '--subject', 'test-user'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"token"')
      expect(result.stdout).toContain('"subject"')
      expect(result.stdout).toContain('test-user')

      // Verify it's valid JSON
      const output = JSON.parse(result.stdout)
      expect(output.token).toBeDefined()
      expect(typeof output.token).toBe('string')
      expect(output.subject).toBe('test-user')
    })

    it('should generate token with expiry', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI([
        'service-token',
        'generate',
        '--subject',
        'test-user',
        '--expires-in',
        '30m',
      ])

      expect(result.exitCode).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.token).toBeDefined()
      expect(output.expiresIn).toBe('30m')
    })

    it('should generate token with audience', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI([
        'service-token',
        'generate',
        '--subject',
        'test-user',
        '--audience',
        'service-a',
        '--audience',
        'service-b',
      ])

      expect(result.exitCode).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.token).toBeDefined()
      expect(output.audience).toEqual(['service-a', 'service-b'])
    })

    it('should generate token with custom claims', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const claims = '{"role":"admin","permissions":["read","write"]}'
      const result = await runCLI([
        'service-token',
        'generate',
        '--subject',
        'test-user',
        '--claims',
        claims,
      ])

      expect(result.exitCode).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.token).toBeDefined()
      expect(output.claims).toEqual({
        role: 'admin',
        permissions: ['read', 'write'],
      })
    })

    it('should output raw token with --raw flag', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI(['service-token', 'generate', '--subject', 'test-user', '--raw'])

      expect(result.exitCode).toBe(0)
      // Raw output should be just the token, no JSON
      expect(result.stdout).not.toContain('"token"')
      expect(result.stdout).not.toContain('"subject"')
      // Should be a JWT (three parts separated by dots)
      const parts = result.stdout.trim().split('.')
      expect(parts.length).toBe(3)
    })

    it('should fail without required subject', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI(['service-token', 'generate'])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('required option')
      expect(result.stderr).toContain('subject')
    })

    it('should fail with invalid claims JSON', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const result = await runCLI([
        'service-token',
        'generate',
        '--subject',
        'test-user',
        '--claims',
        '{invalid json}',
      ])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('Invalid JSON')
    })

    it('should generate token with all options', async () => {
      if (skipTests || !container) {
        console.log('Skipping test: Podman/Docker not available')
        return
      }
      const claims = '{"role":"admin"}'
      const result = await runCLI([
        'service-token',
        'generate',
        '--subject',
        'test-user',
        '--expires-in',
        '7d',
        '--audience',
        'service-a',
        '--audience',
        'service-b',
        '--claims',
        claims,
      ])

      expect(result.exitCode).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.token).toBeDefined()
      expect(output.subject).toBe('test-user')
      expect(output.expiresIn).toBe('7d')
      expect(output.audience).toEqual(['service-a', 'service-b'])
      expect(output.claims).toEqual({ role: 'admin' })
    })
  })
}
