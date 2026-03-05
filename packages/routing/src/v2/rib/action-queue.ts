/**
 * Serializes async operations into a sequential queue.
 * Prevents concurrent dispatch from causing TOCTOU race conditions.
 */
export class ActionQueue {
  private tail: Promise<void> = Promise.resolve()

  /**
   * Enqueue an async operation. Operations execute sequentially —
   * each waits for the previous to complete before starting.
   * Errors in one operation do not block subsequent operations.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn)
    this.tail = task.then(
      () => {},
      () => {}
    )
    return task
  }
}
