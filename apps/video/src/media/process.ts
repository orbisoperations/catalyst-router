import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessManager } from './manager.js'

/**
 * Concrete ProcessManager that spawns the MediaMTX binary as a child process.
 *
 * start() spawns `mediamtx <configPath>` and waits briefly for the process to
 * either stabilize or fail with an immediate exit/error.
 *
 * stop() sends SIGTERM and falls back to SIGKILL after a timeout.
 */
export class MediaMTXProcess implements ProcessManager {
  private child: ChildProcess | null = null

  constructor(
    private configPath: string,
    private binaryPath = 'mediamtx'
  ) {}

  async start(): Promise<void> {
    if (this.child) return

    this.child = spawn(this.binaryPath, [this.configPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })

    // Wait briefly for the process to either stabilize or fail immediately
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 1000)

      const onError = (err: Error) => {
        cleanup()
        this.child = null
        reject(err)
      }

      const onExit = (code: number | null) => {
        cleanup()
        this.child = null
        if (code !== null && code !== 0) {
          reject(new Error(`mediamtx exited with code ${code}`))
          return
        }
        reject(new Error('mediamtx exited unexpectedly during startup'))
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.child?.removeListener('error', onError)
        this.child?.removeListener('exit', onExit)
      }

      this.child!.on('error', onError)
      this.child!.on('exit', onExit)
    })

    // Persistent listener: track unexpected exits after stabilization
    this.child?.on('exit', () => {
      this.child = null
    })
  }

  async stop(): Promise<void> {
    if (!this.child) return

    const child = this.child
    this.child = null
    child.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)

      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }
}
