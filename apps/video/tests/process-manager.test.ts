import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { ProcessManager } from '../src/mediamtx/process-manager.js'

function createMockChild(pid = 12345) {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    pid,
    stdin: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        ;(child as any).exitCode = signal === 'SIGKILL' ? 137 : 0
        child.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal)
      }
      return true
    }),
  })
  return child
}

function createManager(mockSpawn: ReturnType<typeof vi.fn>, opts?: { maxRestarts?: number }) {
  return new ProcessManager({
    binaryPath: '/usr/bin/mediamtx',
    configPath: '/tmp/mediamtx.yml',
    maxRestarts: opts?.maxRestarts ?? 3,
    shutdownTimeout: 100,
    spawnFn: mockSpawn as any,
  })
}

describe('ProcessManager', () => {
  let mockSpawn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockSpawn = vi.fn()
  })

  it('starts in stopped state', () => {
    const manager = createManager(mockSpawn)
    expect(manager.state).toBe('stopped')
  })

  it('transitions to running on successful spawn', async () => {
    const child = createMockChild()
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    const started = new Promise<number>((resolve) => manager.on('started', resolve))
    manager.start()
    child.emit('spawn')
    const pid = await started

    expect(manager.state).toBe('running')
    expect(pid).toBe(12345)
  })

  it('spawns with correct binary and config arguments', () => {
    const child = createMockChild()
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    manager.start()
    child.emit('spawn')

    expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/mediamtx', ['/tmp/mediamtx.yml'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('auto-restarts on crash up to maxRestarts', () => {
    const restartEvents: [number, number][] = []
    const manager = createManager(mockSpawn)
    manager.on('restarting', (attempt, max) => restartEvents.push([attempt, max]))

    // First spawn + crash
    const c1 = createMockChild(1001)
    mockSpawn.mockReturnValue(c1)
    manager.start()
    c1.emit('spawn')

    // Crash 1 → restart 1
    const c2 = createMockChild(1002)
    mockSpawn.mockReturnValue(c2)
    c1.emit('exit', 1, null)
    c2.emit('spawn')

    expect(manager.state).toBe('running')
    expect(restartEvents).toHaveLength(1)
    expect(restartEvents[0]).toEqual([1, 3])

    // Crash 2 → restart 2
    const c3 = createMockChild(1003)
    mockSpawn.mockReturnValue(c3)
    c2.emit('exit', 1, null)
    c3.emit('spawn')

    expect(manager.state).toBe('running')
    expect(restartEvents).toHaveLength(2)
  })

  it('enters degraded state after exhausting restart budget', () => {
    // maxRestarts=2 means 2 restart attempts allowed after initial crash
    const manager = createManager(mockSpawn, { maxRestarts: 2 })
    let degradedFired = false
    manager.on('degraded', () => {
      degradedFired = true
    })

    // Initial spawn succeeds
    const c1 = createMockChild(1)
    mockSpawn.mockReturnValue(c1)
    manager.start()
    c1.emit('spawn')
    expect(manager.state).toBe('running')

    // Crash 1 → triggers restart attempt 1
    // The restarted process crashes immediately (no spawn event)
    const c2 = createMockChild(2)
    mockSpawn.mockReturnValue(c2)
    c1.emit('exit', 1, null)
    // c2 crashes immediately before spawning
    const c3 = createMockChild(3)
    mockSpawn.mockReturnValue(c3)
    c2.emit('exit', 1, null)
    // c3 crashes immediately — this is the 3rd crash, exceeding maxRestarts=2
    c3.emit('exit', 1, null)

    expect(degradedFired).toBe(true)
    expect(manager.state).toBe('degraded')
  })

  it('sends SIGTERM on stop', async () => {
    const child = createMockChild()
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        ;(child as any).exitCode = 0
        child.emit('exit', 0, 'SIGTERM')
      }
      return true
    })
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    manager.start()
    child.emit('spawn')
    await manager.stop()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(manager.state).toBe('stopped')
  })

  it('escalates to SIGKILL if SIGTERM times out', async () => {
    const child = createMockChild()
    const killCalls: string[] = []
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      killCalls.push(String(signal ?? ''))
      if (signal === 'SIGKILL') {
        ;(child as any).exitCode = 137
        child.emit('exit', 137, 'SIGKILL')
      }
      // SIGTERM does NOT trigger exit — simulating a hang
      return true
    })
    mockSpawn.mockReturnValue(child)
    // Use a very short shutdown timeout so the test doesn't actually wait
    const manager = new ProcessManager({
      binaryPath: '/usr/bin/mediamtx',
      configPath: '/tmp/mediamtx.yml',
      maxRestarts: 3,
      shutdownTimeout: 10,
      spawnFn: mockSpawn as any,
    })

    manager.start()
    child.emit('spawn')

    await manager.stop()

    expect(killCalls).toContain('SIGTERM')
    expect(killCalls).toContain('SIGKILL')
    expect(manager.state).toBe('stopped')
  })

  it('does not restart after intentional stop', async () => {
    const child = createMockChild()
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        ;(child as any).exitCode = 0
        child.emit('exit', 0, 'SIGTERM')
      }
      return true
    })
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    manager.start()
    child.emit('spawn')
    await manager.stop()

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(manager.state).toBe('stopped')
  })

  it('resets restart count on successful run', () => {
    const manager = createManager(mockSpawn, { maxRestarts: 2 })

    const c1 = createMockChild(1)
    mockSpawn.mockReturnValue(c1)
    manager.start()
    c1.emit('spawn') // running — restartCount resets

    // Crash → restart
    const c2 = createMockChild(2)
    mockSpawn.mockReturnValue(c2)
    c1.emit('exit', 1, null)
    c2.emit('spawn') // running — restartCount resets again

    // Crash → restart (should succeed because count was reset)
    const c3 = createMockChild(3)
    mockSpawn.mockReturnValue(c3)
    c2.emit('exit', 1, null)
    c3.emit('spawn')

    expect(manager.state).toBe('running')
  })

  it('is idempotent when start is called while running', () => {
    const child = createMockChild()
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    manager.start()
    child.emit('spawn')

    manager.start()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('calls restarting callback with attempt=1 after each successful recovery', () => {
    const restartEvents: [number, number][] = []
    const manager = createManager(mockSpawn, { maxRestarts: 3 })
    manager.on('restarting', (attempt, max) => restartEvents.push([attempt, max]))

    const c1 = createMockChild(1001)
    mockSpawn.mockReturnValue(c1)
    manager.start()
    c1.emit('spawn')

    // Each crash-then-successful-spawn resets restartCount to 0,
    // so the next crash always starts at attempt=1
    const c2 = createMockChild(1002)
    mockSpawn.mockReturnValue(c2)
    c1.emit('exit', 1, null)
    c2.emit('spawn')

    const c3 = createMockChild(1003)
    mockSpawn.mockReturnValue(c3)
    c2.emit('exit', 1, null)
    c3.emit('spawn')

    const c4 = createMockChild(1004)
    mockSpawn.mockReturnValue(c4)
    c3.emit('exit', 1, null)
    c4.emit('spawn')

    expect(restartEvents).toEqual([
      [1, 3],
      [1, 3],
      [1, 3],
    ])
  })

  it('handles spawn error (binary not found)', () => {
    const child = createMockChild()
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn, { maxRestarts: 0 })
    let degradedFired = false
    manager.on('degraded', () => {
      degradedFired = true
    })

    manager.start()

    const err = new Error('spawn /bad/path ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    child.emit('error', err)

    expect(degradedFired).toBe(true)
    expect(manager.state).toBe('degraded')
  })

  it('handles exit with signal (e.g., SIGKILL from OOM)', () => {
    const restartEvents: [number, number][] = []
    const manager = createManager(mockSpawn, { maxRestarts: 3 })
    manager.on('restarting', (attempt, max) => restartEvents.push([attempt, max]))

    const c1 = createMockChild(1001)
    mockSpawn.mockReturnValue(c1)
    manager.start()
    c1.emit('spawn')

    const c2 = createMockChild(1002)
    mockSpawn.mockReturnValue(c2)
    c1.emit('exit', null, 'SIGKILL')
    c2.emit('spawn')

    expect(restartEvents).toEqual([[1, 3]])
    expect(manager.state).toBe('running')
  })

  it('stop() is idempotent when process not running', async () => {
    const manager = createManager(mockSpawn)
    expect(manager.state).toBe('stopped')
    await manager.stop()
    expect(manager.state).toBe('stopped')
  })

  it('emits exited event with code and signal', async () => {
    const child = createMockChild()
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        ;(child as any).exitCode = 0
        child.emit('exit', 0, 'SIGTERM')
      }
      return true
    })
    mockSpawn.mockReturnValue(child)
    const manager = createManager(mockSpawn)

    const exited = new Promise<[number | null, string | null]>((resolve) =>
      manager.on('exited', (code, signal) => resolve([code, signal]))
    )

    manager.start()
    child.emit('spawn')
    await manager.stop()

    const [code, signal] = await exited
    expect(code).toBe(0)
    expect(signal).toBe('SIGTERM')
  })
})
