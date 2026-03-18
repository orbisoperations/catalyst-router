import type { ActionLog } from '@catalyst/routing/v2'
import type { RouteTable } from '@catalyst/routing/v2'
import { getLogger, WideEvent } from '@catalyst/telemetry'

const logger = getLogger(['catalyst', 'orchestrator', 'compaction'])

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
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: CompactionManagerOptions) {
    this.journal = opts.journal
    this.getState = opts.getState
    this.intervalMs = opts.intervalMs ?? 86_400_000
    this.minEntries = opts.minEntries ?? 1000
    this.tailSize = opts.tailSize ?? 100
  }

  /** Start periodic compaction. No-op if intervalMs is 0 or already running. */
  start(): void {
    if (this.intervalMs === 0 || this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.compact().catch((err) => {
        logger.error('Compaction cycle failed', { 'event.name': 'compaction.failed', error: err })
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
    const event = new WideEvent('orchestrator.compaction', logger)
    const lastSeq = this.journal.lastSeq()
    event.set('catalyst.orchestrator.journal.last_seq', lastSeq)

    if (lastSeq === 0) {
      event.set('catalyst.orchestrator.compaction.skipped', true)
      event.emit()
      return { skipped: true, reason: 'empty journal' }
    }

    const existingSnapshot = this.journal.getSnapshot()
    const entriesSinceSnapshot = existingSnapshot ? lastSeq - existingSnapshot.atSeq : lastSeq

    if (entriesSinceSnapshot < this.minEntries) {
      event.set('catalyst.orchestrator.compaction.skipped', true)
      event.emit()
      return {
        skipped: true,
        reason: `only ${entriesSinceSnapshot} entries since last snapshot (threshold: ${this.minEntries})`,
      }
    }

    // Step 1: Snapshot
    const state = this.getState()
    this.journal.snapshot(lastSeq, state)

    // Step 2: Prune, retaining tailSize entries
    const pruneBeforeSeq = Math.max(1, lastSeq - this.tailSize + 1)
    const pruned = this.journal.prune(pruneBeforeSeq)

    // Step 3: Vacuum if supported (SQLite)
    if (
      'vacuum' in this.journal &&
      typeof (this.journal as { vacuum: unknown }).vacuum === 'function'
    ) {
      ;(this.journal as { vacuum(): void }).vacuum()
    }

    event.set({
      'catalyst.orchestrator.compaction.snapshot_seq': lastSeq,
      'catalyst.orchestrator.compaction.pruned': pruned,
    })
    event.emit()

    return { skipped: false, snapshotAtSeq: lastSeq, pruned }
  }
}

export type CompactionResult =
  | { skipped: true; reason: string }
  | { skipped: false; snapshotAtSeq: number; pruned: number }
