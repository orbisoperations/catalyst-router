import Database from 'better-sqlite3'
import { SqliteActionLog, InMemoryActionLog, RoutingInformationBase } from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import { OrchestratorBus } from './bus.js'
import { TickManager } from './tick-manager.js'
import { ReconnectManager } from './reconnect.js'
import type { PeerTransport } from './transport.js'
import type { OrchestratorConfig } from '../v1/types.js'

export interface OrchestratorServiceV2Options {
  config: OrchestratorConfig
  transport: PeerTransport
  nodeToken?: string
  /** File path for a SQLite-backed journal. Omit for an in-memory journal (tests/dev). */
  journalPath?: string
}

/**
 * V2 Orchestrator service composition.
 *
 * Wires together:
 * - ActionLog (SQLite or in-memory)
 * - Journal replay → initial RouteTable reconstruction
 * - OrchestratorBus (RIB + action dispatch + transport side effects)
 * - TickManager (periodic keepalive / hold-timer checks)
 * - ReconnectManager (exponential-backoff reconnect on transport errors)
 *
 * Intentionally not a CatalystService subclass — auth / RPC wiring is handled
 * by the caller (e.g. a Hono route that gates calls behind token validation).
 */
export class OrchestratorServiceV2 {
  readonly bus: OrchestratorBus
  readonly tickManager: TickManager
  readonly reconnectManager: ReconnectManager
  private readonly journal: ActionLog

  constructor(opts: OrchestratorServiceV2Options) {
    // 1. Create the journal (SQLite on disk or in-memory).
    if (opts.journalPath !== undefined) {
      const db = new Database(opts.journalPath)
      this.journal = new SqliteActionLog(db)
    } else {
      this.journal = new InMemoryActionLog()
    }

    // 2. Replay journal entries to reconstruct the last-known route table.
    //    We use a temporary RIB (no journal) so we don't double-append on replay.
    const tempRib = new RoutingInformationBase({ nodeId: opts.config.node.name })
    for (const entry of this.journal.replay()) {
      const plan = tempRib.plan(entry.action, tempRib.state)
      if (tempRib.stateChanged(plan)) {
        tempRib.commit(plan, entry.action)
      }
    }

    // 3. Create the bus with the replayed initial state.
    //    The journal is passed so that new actions are appended going forward.
    this.bus = new OrchestratorBus({
      config: opts.config,
      transport: opts.transport,
      journal: this.journal,
      nodeToken: opts.nodeToken,
      initialState: tempRib.state,
    })

    // 4. Create the tick manager — drives hold-timer checks on a periodic interval.
    this.tickManager = new TickManager({
      dispatchFn: (action) => this.bus.dispatch(action),
    })

    // 5. Create the reconnect manager — schedules retries on transport errors.
    this.reconnectManager = new ReconnectManager({
      transport: opts.transport,
      dispatchFn: (action) => this.bus.dispatch(action),
      nodeToken: opts.nodeToken,
    })
  }

  /** Start periodic tick dispatch (idempotent). */
  start(): void {
    this.tickManager.start()
  }

  /** Stop all timers and cancel pending reconnects. */
  async stop(): Promise<void> {
    this.tickManager.stop()
    this.reconnectManager.stopAll()
  }

  /** Propagate a refreshed node token to the bus and reconnect manager. */
  setNodeToken(token: string): void {
    this.bus.setNodeToken(token)
    this.reconnectManager.setNodeToken(token)
  }
}
