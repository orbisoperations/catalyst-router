import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMTXProcess } from '../src/media/process.js'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process')
  return {
    ...actual,
    spawn: spawnMock,
  }
})

class FakeChild extends EventEmitter {
  killed = false
}

describe('MediaMTXProcess', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('rejects when mediamtx exits with code 0 during startup window', async () => {
    const child = new FakeChild() as unknown as ChildProcess
    spawnMock.mockReturnValue(child)

    const process = new MediaMTXProcess('/tmp/mediamtx.yaml')
    const startPromise = process.start()

    child.emit('exit', 0)

    await expect(startPromise).rejects.toThrow('mediamtx exited unexpectedly during startup')
    expect(process.isRunning()).toBe(false)
  })
})
