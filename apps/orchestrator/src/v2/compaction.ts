import type { ActionLog } from '@catalyst/routing/v2'
import type { RouteTable } from '@catalyst/routing/v2'

export interface CompactionManagerOptions {
  /** The journal to compact. */
  journal: ActionLog
  /** Function that returns the current route table state. */
  getState: () => RouteTable
  /** Compaction interval in milliseconds. 0 disables periodic compaction. Default: 86_400_000 (24h). */
  intervalMs?: number
  /** Minimum journal entries before compaction triggers. Default: 1000. */
  minEntries?: number
  /** Entries to retain after snapshot for debugging. Default: 100. */
  tailSize?: number
  /** Optional logger. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

/**
 * Drives periodic snapshot + truncate compaction on an ActionLog.
 *
 * Compaction flow:
 *   1. Check if journal has >= minEntries since last snapshot
 *   2. Write a snapshot of current RouteTable at lastSeq
 *   3. Prune entries older than (lastSeq - tailSize)
 *   4. If SQLite, vacuum to reclaim disk space
 *
 * Timer-based: starts an interval that calls compact() periodically.
 * Can also be called manually via compact().
 */
export class CompactionManager {
  private readonly journal: ActionLog
  private readonly getState: () => RouteTable
  private readonly intervalMs: number
  private readonly minEntries: number
  private readonly tailSize: number
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: CompactionManagerOptions) {
    this.journal = opts.journal
    this.getState = opts.getState
    this.intervalMs = opts.intervalMs ?? 86_400_000
    this.minEntries = opts.minEntries ?? 1000
    this.tailSize = opts.tailSize ?? 100
    this.logger = opts.logger
  }

  /** Start periodic compaction. No-op if intervalMs is 0 or already running. */
  start(): void {
    if (this.intervalMs === 0 || this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.compact().catch((err) => {
        this.logger?.error('[CompactionManager] compaction failed:', err)
      })
    }, this.intervalMs)
  }

  /** Stop periodic compaction. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  get isRunning(): boolean {
    return this.timer !== undefined
  }

  /**
   * Run a single compaction cycle.
   *
   * Steps:
   *   1. Read lastSeq and existing snapshot to determine entry count
   *   2. Skip if fewer than minEntries have accumulated since last snapshot
   *   3. Snapshot current state at lastSeq
   *   4. Prune entries before (lastSeq - tailSize)
   *   5. Vacuum if the journal supports it (SQLite)
   *
   * Returns a summary of what was done.
   */
  async compact(): Promise<CompactionResult> {
    const lastSeq = this.journal.lastSeq()
    if (lastSeq === 0) {
      return { skipped: true, reason: 'empty journal' }
    }

    const existingSnapshot = this.journal.getSnapshot()
    const entriesSinceSnapshot = existingSnapshot ? lastSeq - existingSnapshot.atSeq : lastSeq

    if (entriesSinceSnapshot < this.minEntries) {
      return {
        skipped: true,
        reason: `only ${entriesSinceSnapshot} entries since last snapshot (threshold: ${this.minEntries})`,
      }
    }

    // Step 1: Snapshot
    const state = this.getState()
    this.journal.snapshot(lastSeq, state)
    this.logger?.info(`[CompactionManager] snapshot written at seq ${lastSeq}`)

    // Step 2: Prune, retaining tailSize entries
    const pruneBeforeSeq = Math.max(1, lastSeq - this.tailSize + 1)
    const pruned = this.journal.prune(pruneBeforeSeq)
    this.logger?.info(
      `[CompactionManager] pruned ${pruned} entries (retained tail from seq ${pruneBeforeSeq})`
    )

    // Step 3: Vacuum if supported (SQLite)
    if (
      'vacuum' in this.journal &&
      typeof (this.journal as { vacuum: unknown }).vacuum === 'function'
    ) {
      ;(this.journal as { vacuum(): void }).vacuum()
      this.logger?.info('[CompactionManager] vacuum completed')
    }

    return { skipped: false, snapshotAtSeq: lastSeq, pruned }
  }
}

export type CompactionResult =
  | { skipped: true; reason: string }
  | { skipped: false; snapshotAtSeq: number; pruned: number }
