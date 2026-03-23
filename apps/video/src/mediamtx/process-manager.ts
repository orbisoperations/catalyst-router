import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export type ProcessState = 'stopped' | 'starting' | 'running' | 'restarting' | 'degraded'

export interface ProcessManagerOptions {
  /** Path to the MediaMTX binary. */
  binaryPath: string
  /** Path to the generated MediaMTX YAML config. */
  configPath: string
  /** Maximum restart attempts before entering degraded state. */
  maxRestarts?: number
  /** Timeout in ms for graceful shutdown (SIGTERM → SIGKILL). */
  shutdownTimeout?: number
  /** Override spawn function for testing. */
  spawnFn?: typeof spawn
}

interface ProcessManagerEvents {
  stateChange: [state: ProcessState]
  started: [pid: number]
  exited: [code: number | null, signal: NodeJS.Signals | null]
  restarting: [attempt: number, maxAttempts: number]
  degraded: []
}

/**
 * Supervises MediaMTX as a child process.
 *
 * Spawn → monitor → auto-restart on crash (up to maxRestarts).
 * Enters degraded state when restart budget is exhausted. The parent
 * VideoStreamService should surface degraded state via health checks
 * and OTEL metrics.
 */
export class ProcessManager extends EventEmitter<ProcessManagerEvents> {
  private process: ChildProcess | null = null
  private _state: ProcessState = 'stopped'
  private restartCount = 0
  private readonly maxRestarts: number
  private readonly shutdownTimeout: number
  private readonly binaryPath: string
  private readonly configPath: string
  private readonly spawnFn: typeof spawn
  private intentionalStop = false

  constructor(options: ProcessManagerOptions) {
    super()
    this.binaryPath = options.binaryPath
    this.configPath = options.configPath
    this.maxRestarts = options.maxRestarts ?? 3
    this.shutdownTimeout = options.shutdownTimeout ?? 5000
    this.spawnFn = options.spawnFn ?? spawn
  }

  get state(): ProcessState {
    return this._state
  }

  get pid(): number | undefined {
    return this.process?.pid
  }

  async start(): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') return

    this.intentionalStop = false
    this.restartCount = 0
    await this.spawnProcess()
  }

  async stop(): Promise<void> {
    this.intentionalStop = true
    await this.killProcess()
    this.setState('stopped')
  }

  private async spawnProcess(): Promise<void> {
    this.setState('starting')

    const child = this.spawnFn(this.binaryPath, [this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.process = child

    child.on('spawn', () => {
      this.setState('running')
      this.restartCount = 0
      if (child.pid) this.emit('started', child.pid)
    })

    child.on('error', (err) => {
      if (!this.intentionalStop) {
        this.handleCrash(null, null, err)
      }
    })

    child.on('exit', (code, signal) => {
      this.emit('exited', code, signal)
      if (!this.intentionalStop) {
        this.handleCrash(code, signal)
      }
    })
  }

  private handleCrash(_code: number | null, _signal: NodeJS.Signals | null, _error?: Error): void {
    this.process = null
    this.restartCount++

    if (this.restartCount > this.maxRestarts) {
      this.setState('degraded')
      this.emit('degraded')
      return
    }

    this.setState('restarting')
    this.emit('restarting', this.restartCount, this.maxRestarts)
    void this.spawnProcess()
  }

  private async killProcess(): Promise<void> {
    const child = this.process
    if (!child || child.exitCode !== null) {
      this.process = null
      return
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
      }, this.shutdownTimeout)

      child.once('exit', () => {
        clearTimeout(timeout)
        this.process = null
        resolve()
      })

      child.kill('SIGTERM')
    })
  }

  private setState(state: ProcessState): void {
    if (this._state === state) return
    this._state = state
    this.emit('stateChange', state)
  }
}
