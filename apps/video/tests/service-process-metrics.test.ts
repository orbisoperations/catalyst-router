import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalystConfig } from '@catalyst/config'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { VideoConfigSchema } from '../src/config.js'

const metricSpies = vi.hoisted(() => ({
  mediamtxRunningAdd: vi.fn(),
  mediamtxCrashesAdd: vi.fn(),
  mediamtxRestartsAdd: vi.fn(),
}))

vi.mock('../src/metrics.js', () => ({
  createVideoMetrics: () => ({
    mediamtxRunning: { add: metricSpies.mediamtxRunningAdd },
    mediamtxCrashes: { add: metricSpies.mediamtxCrashesAdd },
    mediamtxRestarts: { add: metricSpies.mediamtxRestartsAdd },
    streamActive: { add() {} },
    streamPublishes: { add() {} },
    streamDisconnects: { add() {} },
    routeOperations: { add() {} },
    relayActive: { add() {} },
    relaySetupDuration: { record() {} },
    relaySetups: { add() {} },
    authChecks: { add() {} },
    authLatency: { record() {} },
    authFailures: { add() {} },
  }),
}))

const { VideoStreamService } = await import('../src/service.js')

function makeVideoConfig(overrides: Record<string, unknown> = {}) {
  return VideoConfigSchema.parse({
    enabled: true,
    orchestratorEndpoint: 'ws://localhost:3000',
    authEndpoint: 'http://localhost:3001',
    systemToken: 'test-token',
    ...overrides,
  })
}

function makeCatalystConfig(): CatalystConfig {
  return {
    port: 3002,
    node: {
      name: 'test-node',
      domains: ['test.local'],
    },
  }
}

class FakeProcessManager {
  state = 'stopped'
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  async start(): Promise<void> {
    this.state = 'running'
    this.emit('started', 1234)
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.emit('exited', 0, 'SIGTERM')
  }

  emitExited(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.state = 'stopped'
    this.emit('exited', exitCode, signal)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args)
    }
  }
}

function makeFakeRouteManager() {
  return {
    handleReady: vi.fn(),
    handleNotReady: vi.fn(),
    withdrawAll: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    streamCount: 0,
  }
}

function makeFakeRelayManager() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    relayCount: 0,
  }
}

describe('VideoStreamService process metrics', () => {
  let telemetry: Awaited<ReturnType<typeof TelemetryBuilder.noop>>

  beforeEach(() => {
    telemetry = TelemetryBuilder.noop('video')
    vi.clearAllMocks()
  })

  it('does not count graceful shutdown as a mediamtx crash', async () => {
    const processManager = new FakeProcessManager()

    const service = await VideoStreamService.create({
      config: makeCatalystConfig(),
      videoConfig: makeVideoConfig(),
      telemetry,
      deps: {
        createControlApiClient: () => ({ getPath: vi.fn() }) as any,
        createProcessManager: () => processManager as any,
        createStreamRouteManager: () => makeFakeRouteManager() as any,
        createRelayManager: () => makeFakeRelayManager() as any,
        createReconnectingClient: () =>
          ({
            on: vi.fn(),
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn(),
          }) as any,
        createTokenScheduler: () =>
          ({
            start: vi.fn(),
            stop: vi.fn(),
          }) as any,
      },
    })

    metricSpies.mediamtxCrashesAdd.mockClear()

    await service.shutdown()

    expect(metricSpies.mediamtxCrashesAdd).not.toHaveBeenCalled()
    expect(metricSpies.mediamtxRunningAdd).toHaveBeenCalledWith(-1)
  })

  it('counts unexpected process exits as mediamtx crashes', async () => {
    const processManager = new FakeProcessManager()

    const service = await VideoStreamService.create({
      config: makeCatalystConfig(),
      videoConfig: makeVideoConfig(),
      telemetry,
      deps: {
        createControlApiClient: () => ({ getPath: vi.fn() }) as any,
        createProcessManager: () => processManager as any,
        createStreamRouteManager: () => makeFakeRouteManager() as any,
        createRelayManager: () => makeFakeRelayManager() as any,
        createReconnectingClient: () =>
          ({
            on: vi.fn(),
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn(),
          }) as any,
        createTokenScheduler: () =>
          ({
            start: vi.fn(),
            stop: vi.fn(),
          }) as any,
      },
    })

    metricSpies.mediamtxCrashesAdd.mockClear()

    processManager.emitExited(1, null)

    expect(metricSpies.mediamtxCrashesAdd).toHaveBeenCalledWith(1)

    await service.shutdown()
  })
})
