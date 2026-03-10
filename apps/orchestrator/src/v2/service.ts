import Database from 'better-sqlite3'
import {
  SqliteActionLog,
  InMemoryActionLog,
  RoutingInformationBase,
  Actions,
} from '@catalyst/routing/v2'
import type { ActionLog } from '@catalyst/routing/v2'
import { OrchestratorBus } from './bus.js'
import type { GatewayClient, EnvoyClient, BusPortAllocator } from './bus.js'
import { TickManager } from './tick-manager.js'
import { ReconnectManager } from './reconnect.js'
import { CompactionManager } from './compaction.js'
import { createGatewayClient } from './gateway-client.js'
import { createEnvoyClient } from './envoy-client.js'
import { createPortAllocator } from '@catalyst/envoy-service'
import type { PeerTransport } from './transport.js'
import type { PeerRecord } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../v1/types.js'

export interface JournalConfig {
  /** "sqlite" for persistent storage, "memory" for ephemeral. Default: "memory". */
  mode?: 'sqlite' | 'memory'
  /** SQLite file path. Required when mode is "sqlite". */
  path?: string
  /** Compaction interval in milliseconds. 0 disables. Default: 86_400_000 (24h). */
  compactionIntervalMs?: number
  /** Minimum entries before compaction triggers. Default: 1000. */
  minEntries?: number
  /** Entries to retain after snapshot. Default: 100. */
  tailSize?: number
}

export interface OrchestratorServiceV2Options {
  config: OrchestratorConfig
  transport: PeerTransport
  nodeToken?: string
  /** File path for a SQLite-backed journal. Omit for an in-memory journal (tests/dev). */
  journalPath?: string
  /** Journal configuration (overrides journalPath if provided). */
  journal?: JournalConfig
  /** Optional gateway client override (for testing). Auto-created from config if omitted. */
  gatewayClient?: GatewayClient
  /** Optional envoy client override (for testing). Auto-created from config if omitted. */
  envoyClient?: EnvoyClient
  /** Optional port allocator override (for testing). Auto-created from config if omitted. */
  portAllocator?: BusPortAllocator
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
  readonly compactionManager: CompactionManager
  private readonly journal: ActionLog
  private readonly transport: PeerTransport
  private nodeToken: string | undefined

  constructor(opts: OrchestratorServiceV2Options) {
    this.transport = opts.transport
    this.nodeToken = opts.nodeToken

    // Resolve journal config: new journal option takes precedence over legacy journalPath.
    const journalConfig: JournalConfig = opts.journal ?? {
      mode: opts.journalPath !== undefined ? 'sqlite' : 'memory',
      path: opts.journalPath,
    }

    // 1. Create the journal (SQLite on disk or in-memory).
    if (journalConfig.mode === 'sqlite') {
      if (!journalConfig.path) {
        throw new Error('journal.path is required when journal.mode is "sqlite"')
      }
      const db = new Database(journalConfig.path)
      this.journal = new SqliteActionLog(db)
    } else {
      this.journal = new InMemoryActionLog()
    }

    // 2. Recover state: snapshot-first, then replay only the tail.
    //    Uses a temporary RIB (no journal) so we don't double-append on replay.
    const tempRib = new RoutingInformationBase({ nodeId: opts.config.node.name })
    const snapshot = this.journal.getSnapshot()
    let replayAfterSeq = 0

    if (snapshot) {
      // Restore from snapshot — apply snapshot state to the temp RIB.
      Object.assign(tempRib.state, snapshot.state)
      replayAfterSeq = snapshot.atSeq
    }

    for (const entry of this.journal.replay(replayAfterSeq)) {
      const plan = tempRib.plan(entry.action, tempRib.state)
      if (tempRib.stateChanged(plan)) {
        tempRib.commit(plan, entry.action)
      }
    }

    // 3. Create the bus with the replayed initial state.
    //    The journal is passed so that new actions are appended going forward.
    const gatewayClient =
      opts.gatewayClient ??
      (opts.config.gqlGatewayConfig?.endpoint
        ? createGatewayClient(opts.config.gqlGatewayConfig.endpoint)
        : undefined)

    const envoyConfig = opts.config.envoyConfig
    const envoyClient =
      opts.envoyClient ??
      (envoyConfig?.endpoint ? createEnvoyClient(envoyConfig.endpoint) : undefined)
    const portAllocator =
      opts.portAllocator ??
      (envoyConfig?.portRange ? createPortAllocator(envoyConfig.portRange) : undefined)

    this.bus = new OrchestratorBus({
      config: opts.config,
      transport: opts.transport,
      journal: this.journal,
      nodeToken: opts.nodeToken,
      initialState: tempRib.state,
      gatewayClient,
      envoyClient,
      portAllocator,
    })

    // 4. Create the compaction manager — periodic snapshot + truncate.
    this.compactionManager = new CompactionManager({
      journal: this.journal,
      getState: () => this.bus.state,
      intervalMs: journalConfig.compactionIntervalMs,
      minEntries: journalConfig.minEntries,
      tailSize: journalConfig.tailSize,
    })

    // 5. Create the tick manager — drives hold-timer checks on a periodic interval.
    this.tickManager = new TickManager({
      dispatchFn: (action) => this.bus.dispatch(action),
    })

    // 6b. Recalculate tick interval after peer connection events so keepalive
    //     frequency tracks the minimum negotiated holdTime (BGP: keepalive = holdTime / 3).
    const peerActions = new Set([Actions.InternalProtocolOpen, Actions.InternalProtocolConnected])
    const originalDispatch = this.bus.dispatch.bind(this.bus)
    this.bus.dispatch = async (action) => {
      const result = await originalDispatch(action)
      if (result.success && peerActions.has(action.action)) {
        this.recalculateTickInterval()
      }
      // GAP-001: auto-dial on LocalPeerCreate
      if (result.success && action.action === Actions.LocalPeerCreate) {
        const peerRecord = result.state.internal.peers.find((p) => p.name === action.data.name)
        if (peerRecord) {
          await this.dialPeer(peerRecord)
        }
      }
      return result
    }

    // 7. Create the reconnect manager — schedules retries on transport errors.
    this.reconnectManager = new ReconnectManager({
      transport: opts.transport,
      dispatchFn: (action) => this.bus.dispatch(action),
      nodeToken: opts.nodeToken,
    })
  }

  /** Start periodic tick dispatch and compaction (idempotent). */
  start(): void {
    this.recalculateTickInterval()
    this.tickManager.start()
    this.compactionManager.start()
  }

  /**
   * Recalculate tick interval from current peer holdTimes.
   * Called on start and after peer connect/open actions to track
   * the minimum negotiated holdTime per BGP spec (keepalive = holdTime / 3).
   */
  recalculateTickInterval(): void {
    const holdTimes = this.bus.state.internal.peers.map((p) => p.holdTime)
    this.tickManager.recalculate(holdTimes)
  }

  /** Stop all timers and cancel pending reconnects. */
  async stop(): Promise<void> {
    this.tickManager.stop()
    this.compactionManager.stop()
    this.reconnectManager.stopAll()
  }

  /** Propagate a refreshed node token to the bus and reconnect manager. */
  setNodeToken(token: string): void {
    this.nodeToken = token
    this.bus.setNodeToken(token)
    this.reconnectManager.setNodeToken(token)
  }

  /**
   * Attempt to dial a peer via transport.openPeer().
   * On success, dispatches InternalProtocolConnected to mark the session live.
   * On failure, delegates to ReconnectManager for exponential backoff retry.
   * Skips if no endpoint or no nodeToken.
   */
  private async dialPeer(peer: PeerRecord): Promise<void> {
    if (!peer.endpoint || !this.nodeToken) return

    try {
      await this.transport.openPeer(peer, this.nodeToken)
      await this.bus.dispatch({
        action: Actions.InternalProtocolConnected,
        data: { peerInfo: { name: peer.name, domains: peer.domains } },
      })
    } catch {
      this.reconnectManager.scheduleReconnect(peer)
    }
  }
}
