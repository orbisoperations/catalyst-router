import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MediaProcessManager } from '../src/media/manager.js'
import type { ProcessManager } from '../src/media/manager.js'

function createMockProcess(): ProcessManager {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isRunning: vi.fn(() => false),
  }
}

describe('MediaProcessManager', () => {
  let mockProcess: ProcessManager
  let manager: MediaProcessManager

  beforeEach(() => {
    mockProcess = createMockProcess()
    manager = new MediaProcessManager(mockProcess)
  })

  describe('start', () => {
    it('starts the underlying process', async () => {
      await manager.start()
      expect(mockProcess.start).toHaveBeenCalledOnce()
    })

    it('marks manager as running after start', async () => {
      vi.mocked(mockProcess.isRunning).mockReturnValue(true)
      await manager.start()
      expect(manager.isRunning()).toBe(true)
    })
  })

  describe('stop', () => {
    it('stops the underlying process', async () => {
      vi.mocked(mockProcess.isRunning).mockReturnValue(true)
      await manager.start()
      await manager.stop()
      expect(mockProcess.stop).toHaveBeenCalledOnce()
    })
  })

  describe('restart', () => {
    it('stops then starts the process', async () => {
      vi.mocked(mockProcess.isRunning).mockReturnValue(true)
      await manager.start()
      await manager.restart()
      expect(mockProcess.stop).toHaveBeenCalled()
      expect(mockProcess.start).toHaveBeenCalledTimes(2)
    })

    it('retries up to 3 times on start failure', async () => {
      vi.mocked(mockProcess.start)
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce(undefined)

      await manager.restart()
      expect(mockProcess.start).toHaveBeenCalledTimes(3)
    })

    it('throws after 3 consecutive start failures', async () => {
      vi.mocked(mockProcess.start)
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))

      await expect(manager.restart()).rejects.toThrow('fail 3')
    })
  })

  describe('reconcile', () => {
    it('resolves without error for empty route list', async () => {
      await expect(manager.reconcile([])).resolves.toBeUndefined()
    })
  })
})
