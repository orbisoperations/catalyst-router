import type { RemoteMediaRoute } from '../types.js'

export interface ProcessManager {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}

const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class MediaProcessManager {
  constructor(private process: ProcessManager) {}

  async start(): Promise<void> {
    await this.process.start()
  }

  async stop(): Promise<void> {
    await this.process.stop()
  }

  isRunning(): boolean {
    return this.process.isRunning()
  }

  async restart(): Promise<void> {
    if (this.process.isRunning()) {
      await this.process.stop()
    }

    let lastError: Error | undefined
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.process.start()
        return
      } catch (e) {
        lastError = e as Error
        if (attempt < MAX_RETRIES) {
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1))
        }
      }
    }
    throw lastError
  }

  async reconcile(_expectedRoutes: RemoteMediaRoute[]): Promise<void> {
    // Phase 5: relay-manager handles reconciliation via MediaServerClient
  }
}
