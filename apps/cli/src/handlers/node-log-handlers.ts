import { createOrchestratorClient } from '../clients/orchestrator-client.js'
import type { LogEntry, FederatedLogEntry } from '../clients/orchestrator-client.js'
import type { ListLogsInput } from '../types.js'
import { formatDuration } from '../output.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max entries per request */
export const DEFAULT_LIMIT = 50

/** Default poll interval for follow mode (ms) */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** Minimum poll interval to prevent tight loops (ms) */
export const MIN_POLL_INTERVAL_MS = 500

/**
 * Action prefixes that represent high-frequency system events.
 * Excluded from results by default unless --all is passed.
 */
export const SYSTEM_ACTION_PREFIXES = ['system:', 'internal:protocol:keepalive']

export function isSystemAction(action: string): boolean {
  return SYSTEM_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ListLogsResult =
  | { success: true; data: { entries: LogEntry[] } }
  | { success: false; error: string }

export type ShowLogResult =
  | { success: true; data: { entry: LogEntry } }
  | { success: false; error: string }

export type ExportLogsResult =
  | { success: true; data: { path: string; count: number } }
  | { success: false; error: string }

export type CountLogsResult =
  | { success: true; data: { count: number; lastSeq: number } }
  | { success: false; error: string }

export type ListActionsResult =
  | { success: true; data: { actions: { action: string; count: number }[] } }
  | { success: false; error: string }

export type BlameResult =
  | { success: true; data: { name: string; entries: LogEntry[] } }
  | { success: false; error: string }

export type DiffSummary = {
  fromSeq: number
  toSeq: number
  fromTime: string
  toTime: string
  duration: string
  totalEntries: number
  operatorEntries: number
  systemEntries: number
  peersCreated: string[]
  peersDeleted: string[]
  routesCreated: string[]
  routesDeleted: string[]
  operatorActions: { seq: number; action: string; entity: string; time: string }[]
}

export type DiffResult = { success: true; data: DiffSummary } | { success: false; error: string }

export type VerifyMismatch = {
  type: 'peer' | 'route'
  name: string
  issue: 'missing_in_journal' | 'missing_in_state' | 'field_mismatch'
  details?: string
}

export type VerifyResult =
  | {
      success: true
      data: { consistent: boolean; journalSeq: number; mismatches: VerifyMismatch[] }
    }
  | { success: false; error: string }

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract entity names (peer names, route names) from a journal entry's
 * action data. Used by `blame` and `diff` commands.
 */
export function extractEntityNames(entry: LogEntry): string[] {
  const data = entry.action.data
  if (!data || typeof data !== 'object') return []

  const obj = data as Record<string, unknown>
  const names: string[] = []

  // local:peer:*, local:route:* → .data.name
  if ('name' in obj && typeof obj.name === 'string') {
    names.push(obj.name)
  }

  // internal:protocol:* → .data.peerInfo.name
  if ('peerInfo' in obj && typeof obj.peerInfo === 'object' && obj.peerInfo !== null) {
    const peerInfo = obj.peerInfo as Record<string, unknown>
    if ('name' in peerInfo && typeof peerInfo.name === 'string') {
      names.push(peerInfo.name)
    }
  }

  // internal:protocol:update → .data.update.updates[].route.name
  if ('update' in obj && typeof obj.update === 'object' && obj.update !== null) {
    const update = obj.update as Record<string, unknown>
    if ('updates' in update && Array.isArray(update.updates)) {
      for (const u of update.updates) {
        if (u && typeof u === 'object' && 'route' in u) {
          const route = (u as Record<string, unknown>).route
          if (route && typeof route === 'object' && 'name' in (route as Record<string, unknown>)) {
            const routeName = (route as Record<string, unknown>).name
            if (typeof routeName === 'string') names.push(routeName)
          }
        }
      }
    }
  }

  return [...new Set(names)]
}

/**
 * Filter entries by time range. Compares using epoch milliseconds to avoid
 * issues with timezone suffix mismatches (Z vs no suffix) in ISO 8601 strings.
 */
export function filterByTimeRange(entries: LogEntry[], since?: string, until?: string): LogEntry[] {
  const sinceMs = since ? new Date(since).getTime() : undefined
  const untilMs = until ? new Date(until).getTime() : undefined

  if ((sinceMs !== undefined && isNaN(sinceMs)) || (untilMs !== undefined && isNaN(untilMs))) {
    return entries // unparseable timestamps — don't filter
  }

  return entries.filter((e) => {
    const entryMs = new Date(e.recorded_at).getTime()
    if (isNaN(entryMs)) return true // keep entries with unparseable timestamps
    if (sinceMs !== undefined && entryMs < sinceMs) return false
    if (untilMs !== undefined && entryMs > untilMs) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List action log entries from the orchestrator journal.
 */
export async function listLogsHandler(
  input: ListLogsInput & { includeSystem?: boolean; since?: string; until?: string }
): Promise<ListLogsResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    let entries = await logResult.client.listEntries(
      input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
    )

    // Time-range filtering
    if (input.since || input.until) {
      entries = filterByTimeRange(entries, input.since, input.until)
    }

    // Filter out system noise unless explicitly requested
    if (!input.includeSystem) {
      entries = entries.filter((e) => !isSystemAction(e.action.action))
    }

    // Client-side action filter
    if (input.action) {
      entries = entries.filter((e) => e.action.action === input.action)
    }

    // Client-side limit
    entries = entries.slice(0, input.limit)

    return { success: true, data: { entries } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Show full detail for a single action log entry by sequence number.
 * Uses the server-side getEntry(seq) to avoid downloading the journal tail.
 */
export async function showLogHandler(input: {
  seq: number
  token?: string
  orchestratorUrl?: string
}): Promise<ShowLogResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    const entry = await logResult.client.getEntry(input.seq)

    if (!entry) {
      return { success: false, error: `No entry found with seq ${input.seq}` }
    }

    return { success: true, data: { entry } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Export action log entries to a JSON file for offline analysis.
 */
export async function exportLogsHandler(
  input: ListLogsInput & {
    outputPath: string
    includeSystem?: boolean
    since?: string
    until?: string
  }
): Promise<ExportLogsResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    let entries = await logResult.client.listEntries(
      input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
    )

    if (input.since || input.until) {
      entries = filterByTimeRange(entries, input.since, input.until)
    }

    if (!input.includeSystem) {
      entries = entries.filter((e) => !isSystemAction(e.action.action))
    }

    if (input.action) {
      entries = entries.filter((e) => e.action.action === input.action)
    }

    if (input.limit) {
      entries = entries.slice(0, input.limit)
    }

    const { writeFile, access } = await import('node:fs/promises')
    const { constants } = await import('node:fs')

    // Check if file already exists
    try {
      await access(input.outputPath, constants.F_OK)
      return {
        success: false,
        error: `File already exists: ${input.outputPath}. Use a different path or remove it first.`,
      }
    } catch {
      // File does not exist — safe to write
    }

    const output = {
      exported_at: new Date().toISOString(),
      entry_count: entries.length,
      entries,
    }

    try {
      await writeFile(input.outputPath, JSON.stringify(output, null, 2), 'utf-8')
    } catch (writeErr: unknown) {
      const code = (writeErr as { code?: string }).code
      if (code === 'EACCES') {
        return { success: false, error: `Permission denied: cannot write to ${input.outputPath}` }
      }
      if (code === 'ENOENT') {
        return { success: false, error: `Directory does not exist for path: ${input.outputPath}` }
      }
      throw writeErr
    }

    return { success: true, data: { path: input.outputPath, count: entries.length } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Count journal entries. Fetches entries and counts client-side.
 */
export async function countLogsHandler(input: {
  afterSeq?: number
  action?: string
  token?: string
  orchestratorUrl?: string
}): Promise<CountLogsResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    // If action filter is specified, we must download and filter client-side.
    // Otherwise use server-side count (one number over the wire).
    if (input.action) {
      const entries = await logResult.client.listEntries(
        input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
      )
      const filtered = entries.filter((e) => e.action.action === input.action)
      const lastSeq = await logResult.client.lastSeq()
      return { success: true, data: { count: filtered.length, lastSeq } }
    }

    const [count, lastSeq] = await Promise.all([
      logResult.client.count(
        input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
      ),
      logResult.client.lastSeq(),
    ])

    return { success: true, data: { count, lastSeq } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * List distinct action types present in the journal.
 * Uses server-side distinctActions() — returns sorted list without
 * transferring individual entries over the wire.
 */
export async function listActionsHandler(input: {
  token?: string
  orchestratorUrl?: string
}): Promise<ListActionsResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    const actionNames = await logResult.client.distinctActions()
    const actions = actionNames.map((action) => ({ action, count: 0 }))

    return { success: true, data: { actions } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Follow action log entries in real time, polling for new entries.
 * Reuses a single WebSocket connection for all polls.
 * Calls `onEntries` for each batch of new entries.
 * Returns a cleanup function to stop following.
 */
export async function followLogsHandler(
  input: ListLogsInput & { interval?: number; includeSystem?: boolean },
  onEntries: (entries: LogEntry[]) => void,
  onError: (error: string) => void
): Promise<() => void> {
  const pollInterval = Math.max(input.interval || DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS)
  let lastSeq = input.afterSeq ?? 0
  let stopped = false

  try {
    // Single connection for the entire follow session
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      onError(logResult.error)
      return () => {
        stopped = true
      }
    }

    const logClient = logResult.client

    const filterEntries = (entries: LogEntry[]): LogEntry[] => {
      let filtered = entries
      if (!input.includeSystem) {
        filtered = filtered.filter((e) => !isSystemAction(e.action.action))
      }
      if (input.action) {
        filtered = filtered.filter((e) => e.action.action === input.action)
      }
      return filtered
    }

    // Fetch initial entries once, update cursor from raw, then filter for display
    const rawInitial = await logClient.listEntries(lastSeq > 0 ? { afterSeq: lastSeq } : undefined)
    if (rawInitial.length > 0) {
      lastSeq = Math.max(...rawInitial.map((e) => e.seq))
      const initial = filterEntries(rawInitial)
      if (initial.length > 0) {
        onEntries(initial)
      }
    }

    // Poll loop reusing the same client — retries transient failures with backoff
    const MAX_CONSECUTIVE_FAILURES = 5
    const poll = async () => {
      let consecutiveFailures = 0
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval))
        if (stopped) break

        try {
          const rawEntries = await logClient.listEntries({ afterSeq: lastSeq })

          if (rawEntries.length > 0) {
            lastSeq = Math.max(...rawEntries.map((e) => e.seq))
            const filtered = filterEntries(rawEntries)
            if (filtered.length > 0) {
              onEntries(filtered)
            }
          }
          consecutiveFailures = 0
        } catch (error) {
          if (stopped) return
          consecutiveFailures++
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            onError(
              `${MAX_CONSECUTIVE_FAILURES} consecutive failures, giving up. Last: ${error instanceof Error ? error.message : String(error)}`
            )
            return
          }
          // Backoff: wait an extra pollInterval per failure
          const backoff = pollInterval * consecutiveFailures
          onError(
            `Poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), retrying in ${backoff}ms...`
          )
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      }
    }

    poll()
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error))
  }

  return () => {
    stopped = true
  }
}

// ---------------------------------------------------------------------------
// blame
// ---------------------------------------------------------------------------

/**
 * Show all journal entries related to a specific entity (peer or route name).
 */
export async function blameHandler(input: {
  name: string
  afterSeq?: number
  limit?: number
  since?: string
  until?: string
  token?: string
  orchestratorUrl?: string
}): Promise<BlameResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    let entries = await logResult.client.listEntries(
      input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
    )

    if (input.since || input.until) {
      entries = filterByTimeRange(entries, input.since, input.until)
    }

    let matching = entries.filter((e) => {
      const names = extractEntityNames(e)
      return names.some((n) => n === input.name)
    })

    if (input.limit) {
      matching = matching.slice(0, input.limit)
    }

    return { success: true, data: { name: input.name, entries: matching } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * Pure computation: summarize a range of entries into a diff.
 * Used by both diffHandler and the TUI.
 */
export function computeDiffSummary(
  entries: LogEntry[],
  fromSeq: number,
  toSeq: number
): DiffSummary {
  const firstTime = entries[0].recorded_at
  const lastTime = entries[entries.length - 1].recorded_at
  const durationMs = new Date(lastTime).getTime() - new Date(firstTime).getTime()

  const peersCreated: string[] = []
  const peersDeleted: string[] = []
  const routesCreated: string[] = []
  const routesDeleted: string[] = []
  const operatorActions: DiffSummary['operatorActions'] = []
  let systemCount = 0

  for (const entry of entries) {
    const action = entry.action.action
    const names = extractEntityNames(entry)
    const primaryName = names[0] || '-'

    if (isSystemAction(action)) {
      systemCount++
      continue
    }

    operatorActions.push({ seq: entry.seq, action, entity: primaryName, time: entry.recorded_at })

    switch (action) {
      case 'local:peer:create':
        if (names[0]) peersCreated.push(names[0])
        break
      case 'local:peer:delete':
        if (names[0]) peersDeleted.push(names[0])
        break
      case 'local:route:create':
        if (names[0]) routesCreated.push(names[0])
        break
      case 'local:route:delete':
        if (names[0]) routesDeleted.push(names[0])
        break
    }
  }

  return {
    fromSeq,
    toSeq,
    fromTime: firstTime,
    toTime: lastTime,
    duration: formatDuration(durationMs),
    totalEntries: entries.length,
    operatorEntries: entries.length - systemCount,
    systemEntries: systemCount,
    peersCreated,
    peersDeleted,
    routesCreated,
    routesDeleted,
    operatorActions,
  }
}

/**
 * Compute a shift-handover summary between two sequence numbers.
 */
export async function diffHandler(input: {
  fromSeq: number
  toSeq: number
  token?: string
  orchestratorUrl?: string
}): Promise<DiffResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    // Fetch entries in the range (fromSeq, toSeq]
    const allEntries = await logResult.client.listEntries({ afterSeq: input.fromSeq })
    const rangeEntries = allEntries.filter((e) => e.seq <= input.toSeq)

    if (rangeEntries.length === 0) {
      return {
        success: false,
        error: `No entries found between seq ${input.fromSeq} and ${input.toSeq}`,
      }
    }

    return { success: true, data: computeDiffSummary(rangeEntries, input.fromSeq, input.toSeq) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Verify journal consistency against the live route table.
 * Delegates to the server-side verify() RPC method which replays the
 * journal and compares against the bus state.
 */
export async function verifyHandler(input: {
  token?: string
  orchestratorUrl?: string
}): Promise<VerifyResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    const result = await logResult.client.verify()
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// federated query
// ---------------------------------------------------------------------------

export type FederatedListHandlerResult =
  | { success: true; data: { entries: FederatedLogEntry[]; unreachable: string[] } }
  | { success: false; error: string }

/**
 * Query journal entries across all connected peers.
 * Fans out via the server's federatedList() RPC method which queries each
 * peer in parallel with a 5-second timeout.
 */
export async function federatedListHandler(input: {
  afterSeq?: number
  limit?: number
  action?: string
  since?: string
  until?: string
  token?: string
  orchestratorUrl?: string
}): Promise<FederatedListHandlerResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    const result = await logResult.client.federatedList({
      afterSeq: input.afterSeq,
      limit: input.limit ?? DEFAULT_LIMIT,
    })

    let entries = result.entries

    // Client-side time range filtering
    if (input.since || input.until) {
      entries = filterByTimeRange(entries, input.since, input.until) as FederatedLogEntry[]
    }

    // Client-side action filter
    if (input.action) {
      entries = entries.filter((e) => e.action.action === input.action)
    }

    // Exclude system events
    entries = entries.filter((e) => !isSystemAction(e.action.action))

    return { success: true, data: { entries, unreachable: result.unreachable } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Stringify an entry's data payload for text matching.
 * Handles nested objects and arrays.
 */
function stringifyEntryData(entry: LogEntry): string {
  const parts: string[] = [entry.action.action, entry.nodeId]
  if (entry.action.data && typeof entry.action.data === 'object') {
    parts.push(JSON.stringify(entry.action.data))
  } else if (entry.action.data !== undefined) {
    parts.push(String(entry.action.data))
  }
  return parts.join(' ').toLowerCase()
}

export type SearchResult =
  | { success: true; data: { entries: LogEntry[]; query: string } }
  | { success: false; error: string }

/**
 * Search journal entries by free-text query across action types and data payloads.
 * Case-insensitive substring match.
 */
export async function searchLogsHandler(input: {
  query: string
  limit?: number
  afterSeq?: number
  since?: string
  token?: string
  orchestratorUrl?: string
}): Promise<SearchResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    // Scope the download with afterSeq if provided
    let entries = await logResult.client.listEntries(
      input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : undefined
    )

    // Client-side time range filter to further limit transfer impact
    if (input.since) {
      const sinceTime = new Date(input.since).getTime()
      entries = entries.filter((e) => new Date(e.recorded_at).getTime() >= sinceTime)
    }

    const needle = input.query.toLowerCase()
    let matches = entries.filter((e) => stringifyEntryData(e).includes(needle))

    if (input.limit) {
      matches = matches.slice(0, input.limit)
    }

    return { success: true, data: { entries: matches, query: input.query } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export type ClearResult =
  | { success: true; data: { pruned: number } }
  | { success: false; error: string }

/**
 * Clear all journal entries by pruning up to the current last sequence.
 * Uses the existing prune(beforeSeq) mechanism on the action log.
 */
export async function clearLogsHandler(input: {
  token?: string
  orchestratorUrl?: string
}): Promise<ClearResult> {
  try {
    const client = await createOrchestratorClient(input.orchestratorUrl)
    const logResult = await client.getLogClient(input.token || '')

    if (!logResult.success) {
      return { success: false, error: logResult.error }
    }

    const pruned = await logResult.client.clear()
    return { success: true, data: { pruned } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
