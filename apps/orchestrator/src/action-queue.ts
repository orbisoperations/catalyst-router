import type { Action } from '@catalyst/routing'

export type DispatchResult = { success: true } | { success: false; error: string }

export class ActionQueue {
  private queue: Array<{
    action: Action
    resolve: (result: DispatchResult) => void
    reject: (error: unknown) => void
  }> = []
  private processing = false

  constructor(private readonly pipeline: (action: Action) => Promise<DispatchResult>) {}

  enqueue(action: Action): Promise<DispatchResult> {
    return new Promise<DispatchResult>((resolve, reject) => {
      this.queue.push({ action, resolve, reject })
      if (!this.processing) this.processNext()
    })
  }

  private async processNext(): Promise<void> {
    this.processing = true
    while (this.queue.length > 0) {
      const { action, resolve, reject } = this.queue.shift()!
      try {
        resolve(await this.pipeline(action))
      } catch (e) {
        reject(e)
      }
    }
    this.processing = false
  }
}
