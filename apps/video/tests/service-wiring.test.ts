import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalystConfig } from '@catalyst/config'
import { TelemetryBuilder } from '@catalyst/telemetry'
import { VideoConfigSchema } from '../src/config.js'

vi.mock('../src/metrics.js', () => ({
  createVideoMetrics: () => ({
    mediamtxRunning: { add() {} },
    mediamtxCrashes: { add() {} },
    mediamtxRestarts: { add() {} },
    streamActive: { add() {} },
    streamPublishes: { add() {} },
    streamDisconnects: { add() {} },
    routeOperations: { add() {} },
    relayActive: { add() {} },
    relaySetupDuration: { record() {} },
    relaySetups: { add() {} },
    authRequests: { add() {} },
    authDuration: { record() {} },
    authFailures: { add() {} },
    sessionKicks: { add() {} },
    revalidationSweeps: { add() {} },
  }),
}))

vi.mock('../src/mediamtx/process-manager.js', () => {
  class MockProcessManager {
    state = 'stopped'
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

    async start(): Promise<void> {
      this.state = 'running'
      this.emit('started', 1234)
    }

    async stop(): Promise<void> {
      this.state = 'stopped'
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
    }
  }

  return { ProcessManager: MockProcessManager }
})

vi.mock('../src/rpc/reconnecting-client.js', () => {
  class MockReconnectingClient {
    on(): this {
      return this
    }

    async start(): Promise<void> {}

    stop(): void {}
  }

  return { ReconnectingClient: MockReconnectingClient }
})

vi.mock('../src/rpc/token-refresh.js', () => {
  class MockTokenRefreshScheduler {
    start(): void {}

    stop(): void {}
  }

  return { TokenRefreshScheduler: MockTokenRefreshScheduler }
})

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
    onSubscribersEvicted: vi.fn(),
    relayCount: 0,
  }
}

describe('VideoStreamService wiring', () => {
  let telemetry: Awaited<ReturnType<typeof TelemetryBuilder.noop>>

  beforeEach(() => {
    telemetry = TelemetryBuilder.noop('video')
  })

  it('builds manager adapters from injected factories and delegates through dataChannel', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()
    const fakeRouteManager = makeFakeRouteManager()
    const fakeRelayManager = makeFakeRelayManager()
    const unsubscribe = vi.fn()
    const listRoutesResult = { local: [], internal: [] }
    const dataChannel = {
      addRoute: vi.fn().mockResolvedValue({ success: true }),
      removeRoute: vi.fn().mockResolvedValue({ success: true }),
      listRoutes: vi.fn().mockResolvedValue(listRoutesResult),
      watchRoutes: vi.fn(() => unsubscribe),
    }

    let streamRouteManagerOptions: Record<string, unknown> | undefined
    let relayManagerOptions: Record<string, unknown> | undefined

    const deps = {
      createStreamRouteManager: vi.fn((options: Record<string, unknown>) => {
        streamRouteManagerOptions = options
        return fakeRouteManager
      }),
      createRelayManager: vi.fn((options: Record<string, unknown>) => {
        relayManagerOptions = options
        return fakeRelayManager
      }),
      createReconnectingClient: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      })),
      createTokenScheduler: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
      deps,
    } as any)

    expect(deps.createStreamRouteManager).toHaveBeenCalledTimes(1)
    expect(deps.createRelayManager).toHaveBeenCalledTimes(1)
    expect(streamRouteManagerOptions).toBeDefined()
    expect(relayManagerOptions).toBeDefined()
    ;(service as any).dataChannel = dataChannel

    const route: {
      name: string
      protocol: 'media'
      endpoint: string
      tags: string[]
    } = {
      name: 'cam-front',
      protocol: 'media' as const,
      endpoint: 'rtsp://10.0.1.5:8554/cam-front',
      tags: ['track:H264'],
    }

    await (
      streamRouteManagerOptions!.registrar as {
        addRoute(route: {
          name: string
          protocol: 'media'
          endpoint: string
          tags: string[]
        }): Promise<void>
        removeRoute(name: string): Promise<void>
      }
    ).addRoute(route)
    expect(dataChannel.addRoute).toHaveBeenCalledWith(route)

    await (
      streamRouteManagerOptions!.registrar as {
        addRoute(route: {
          name: string
          protocol: 'media'
          endpoint: string
          tags: string[]
        }): Promise<void>
        removeRoute(name: string): Promise<void>
      }
    ).removeRoute('cam-front')
    expect(dataChannel.removeRoute).toHaveBeenCalledWith({ name: 'cam-front' })

    const callback = vi.fn()
    const stopWatching = (
      relayManagerOptions!.routeSource as {
        watchRoutes(cb: typeof callback): () => void
        listRoutes(): Promise<typeof listRoutesResult>
      }
    ).watchRoutes(callback)

    expect(stopWatching).toBe(unsubscribe)
    expect(dataChannel.watchRoutes).toHaveBeenCalledWith(callback)

    await expect(
      (
        relayManagerOptions!.routeSource as {
          watchRoutes(cb: typeof callback): () => void
          listRoutes(): Promise<typeof listRoutesResult>
        }
      ).listRoutes()
    ).resolves.toEqual(listRoutesResult)
    expect(dataChannel.listRoutes).toHaveBeenCalledTimes(1)

    await service.shutdown()
  })

  it('creates SessionRegistry and TokenRevalidator via DI factories', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()

    const fakeRegistry = { add: vi.fn(), remove: vi.fn(), clear: vi.fn(), size: 0 }
    const fakeRevalidator = { start: vi.fn(), stop: vi.fn() }

    const deps = {
      createStreamRouteManager: vi.fn(() => makeFakeRouteManager()),
      createRelayManager: vi.fn(() => makeFakeRelayManager()),
      createReconnectingClient: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      })),
      createTokenScheduler: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createSessionRegistry: vi.fn(() => fakeRegistry),
      createTokenRevalidator: vi.fn(() => fakeRevalidator),
    }

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
      deps,
    } as any)

    expect(deps.createSessionRegistry).toHaveBeenCalledTimes(1)
    expect(deps.createTokenRevalidator).toHaveBeenCalledTimes(1)

    // Revalidator should have been started after MediaMTX
    expect(fakeRevalidator.start).toHaveBeenCalledTimes(1)

    // Verify onPathSubscribersEvicted callback is wired
    const revalidatorOpts = deps.createTokenRevalidator.mock.calls[0][0] as Record<string, unknown>
    expect(revalidatorOpts.onPathSubscribersEvicted).toBeTypeOf('function')

    await service.shutdown()

    // Revalidator should be stopped on shutdown
    expect(fakeRevalidator.stop).toHaveBeenCalledTimes(1)
  })

  it('refresh callback triggers rpcClient.reconnect instead of minting', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()

    const reconnectSpy = vi.fn().mockResolvedValue(undefined)
    let capturedRefreshCallback: (() => Promise<number | void>) | undefined

    const deps = {
      createStreamRouteManager: vi.fn(() => makeFakeRouteManager()),
      createRelayManager: vi.fn(() => makeFakeRelayManager()),
      createReconnectingClient: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        reconnect: reconnectSpy,
      })),
      createTokenScheduler: vi.fn((opts: Record<string, unknown>) => {
        capturedRefreshCallback = opts.refresh as () => Promise<number | void>
        return { start: vi.fn(), stop: vi.fn() }
      }),
      createSessionRegistry: vi.fn(() => ({ add: vi.fn(), remove: vi.fn(), clear: vi.fn(), size: 0 })),
      createTokenRevalidator: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    }

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
      deps,
    } as any)

    expect(capturedRefreshCallback).toBeDefined()

    // Trigger the refresh callback — should call reconnect, not mint
    await capturedRefreshCallback!()

    expect(reconnectSpy).toHaveBeenCalledTimes(1)

    await service.shutdown()
  })

  it('triggers onDisconnect when DataChannel addRoute throws (transport failure)', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()

    const onDisconnectSpy = vi.fn()
    const dataChannel = {
      addRoute: vi.fn().mockRejectedValue(new Error('WebSocket closed')),
      removeRoute: vi.fn().mockResolvedValue({ success: true }),
      listRoutes: vi.fn().mockResolvedValue({ local: [], internal: [] }),
      watchRoutes: vi.fn(() => vi.fn()),
    }

    let streamRouteManagerOptions: Record<string, unknown> | undefined

    const deps = {
      createStreamRouteManager: vi.fn((options: Record<string, unknown>) => {
        streamRouteManagerOptions = options
        return makeFakeRouteManager()
      }),
      createRelayManager: vi.fn(() => makeFakeRelayManager()),
      createReconnectingClient: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        onDisconnect: onDisconnectSpy,
        connected: true,
      })),
      createTokenScheduler: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      createSessionRegistry: vi.fn(() => ({ add: vi.fn(), remove: vi.fn(), clear: vi.fn(), size: 0, getByPath: vi.fn().mockReturnValue([]) })),
      createTokenRevalidator: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), addPendingEviction: vi.fn() })),
    }

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
      deps,
    } as any)

    ;(service as any).dataChannel = dataChannel
    ;(service as any).rpcClient = { onDisconnect: onDisconnectSpy, connected: true, stop: vi.fn() }

    const registrar = streamRouteManagerOptions!.registrar as {
      addRoute(route: { name: string; protocol: 'media'; endpoint: string; tags: string[] }): Promise<void>
    }

    // addRoute should throw AND trigger onDisconnect
    await expect(
      registrar.addRoute({ name: 'cam', protocol: 'media', endpoint: 'rtsp://x', tags: [] })
    ).rejects.toThrow('WebSocket closed')

    expect(onDisconnectSpy).toHaveBeenCalledTimes(1)

    await service.shutdown()
  })

  it('does NOT trigger onDisconnect for application-level errors (success: false)', async () => {
    const config = makeCatalystConfig()
    const videoConfig = makeVideoConfig()

    const onDisconnectSpy = vi.fn()
    const dataChannel = {
      addRoute: vi.fn().mockResolvedValue({ success: false, error: 'route already exists' }),
      removeRoute: vi.fn().mockResolvedValue({ success: true }),
      listRoutes: vi.fn().mockResolvedValue({ local: [], internal: [] }),
      watchRoutes: vi.fn(() => vi.fn()),
    }

    let streamRouteManagerOptions: Record<string, unknown> | undefined

    const deps = {
      createStreamRouteManager: vi.fn((options: Record<string, unknown>) => {
        streamRouteManagerOptions = options
        return makeFakeRouteManager()
      }),
      createRelayManager: vi.fn(() => makeFakeRelayManager()),
      createReconnectingClient: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        onDisconnect: onDisconnectSpy,
        connected: true,
      })),
      createTokenScheduler: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      createSessionRegistry: vi.fn(() => ({ add: vi.fn(), remove: vi.fn(), clear: vi.fn(), size: 0, getByPath: vi.fn().mockReturnValue([]) })),
      createTokenRevalidator: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), addPendingEviction: vi.fn() })),
    }

    const service = await VideoStreamService.create({
      config,
      videoConfig,
      telemetry,
      deps,
    } as any)

    ;(service as any).dataChannel = dataChannel
    ;(service as any).rpcClient = { onDisconnect: onDisconnectSpy, connected: true, stop: vi.fn() }

    const registrar = streamRouteManagerOptions!.registrar as {
      addRoute(route: { name: string; protocol: 'media'; endpoint: string; tags: string[] }): Promise<void>
    }

    // Application error — should throw but NOT trigger onDisconnect
    await expect(
      registrar.addRoute({ name: 'cam', protocol: 'media', endpoint: 'rtsp://x', tags: [] })
    ).rejects.toThrow('route already exists')

    expect(onDisconnectSpy).not.toHaveBeenCalled()

    await service.shutdown()
  })
})
