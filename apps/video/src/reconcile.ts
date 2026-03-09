import { getLogger } from '@catalyst/telemetry'
import type { StreamRelayManager } from './stream-relay-manager.js'
import type { StreamCatalog } from './bus-client.js'

const logger = getLogger(['video', 'reconcile'])

// ---------------------------------------------------------------------------
// MediaMTX API types
// ---------------------------------------------------------------------------

interface MediaMTXPathItem {
  name: string
  source: { type: string } | null
  readers: Array<{ type: string }>
}

interface MediaMTXPathList {
  items: MediaMTXPathItem[]
}

// ---------------------------------------------------------------------------
// Reconciler interface
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  mediamtxApiUrl: string
  relayManager: StreamRelayManager
  getCatalog: () => StreamCatalog
  fetchFn?: typeof fetch
}

export interface ReconcileController {
  /** Triggers reconciliation. Queued if already running (latest wins). */
  reconcile(): Promise<void>
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000

async function retryWithBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1)
        logger.warn`${label}: attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${delay}ms: ${err}`
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  logger.error`${label}: all ${MAX_ATTEMPTS} attempts failed: ${lastError}`
  throw lastError
}

// ---------------------------------------------------------------------------
// Path encoding helper
// ---------------------------------------------------------------------------

function encodePathName(name: string): string {
  return name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

// ---------------------------------------------------------------------------
// Core reconciliation logic
// ---------------------------------------------------------------------------

async function performReconciliation(deps: ReconcileDeps): Promise<void> {
  const { mediamtxApiUrl, relayManager, getCatalog } = deps
  const fetchFn = deps.fetchFn ?? fetch

  // 1. Query MediaMTX for active paths
  let pathList: MediaMTXPathList
  try {
    pathList = await retryWithBackoff(async () => {
      const url = `${mediamtxApiUrl}/v3/paths/list`
      const res = await fetchFn(url)
      if (!res.ok) {
        throw new Error(`MediaMTX API returned ${res.status}`)
      }
      return (await res.json()) as MediaMTXPathList
    }, 'GET /v3/paths/list')
  } catch {
    // Best-effort: don't crash if MediaMTX is unreachable
    return
  }

  const items = pathList.items ?? []

  // 2. Build set of catalog stream names for quick lookup
  const catalog = getCatalog()
  const catalogNames = new Set(catalog.streams.map((s) => s.name))

  // 3. Diff and act
  for (const path of items) {
    const inCatalog = catalogNames.has(path.name)
    const readerCount = path.readers?.length ?? 0

    if (!inCatalog) {
      // Orphan: exists in MediaMTX but NOT in catalog -> tear down
      logger.info`Tearing down orphan path: ${path.name}`
      try {
        await retryWithBackoff(async () => {
          const encoded = encodePathName(path.name)
          const url = `${mediamtxApiUrl}/v3/paths/${encoded}`
          const res = await fetchFn(url, { method: 'DELETE' })
          if (!res.ok && res.status !== 404) {
            throw new Error(`DELETE ${path.name} returned ${res.status}`)
          }
        }, `DELETE /v3/paths/${path.name}`)
      } catch {
        // Best-effort: log already happened in retryWithBackoff
      }
    } else if (readerCount > 0) {
      // Active relay with readers -> adopt into relay manager
      logger.info`Adopting active relay: ${path.name} (readers=${readerCount})`
      relayManager.adopt(path.name, readerCount)
    } else {
      // In catalog, 0 readers -> start grace period
      // First adopt with 0 viewers so session exists, then start grace period
      relayManager.adopt(path.name, 0)
      logger.info`Starting grace period for idle relay: ${path.name}`
      relayManager.startGracePeriod(path.name)
    }
  }
}

// ---------------------------------------------------------------------------
// Mutex with queue-latest semantics
// ---------------------------------------------------------------------------

export function createReconciler(deps: ReconcileDeps): ReconcileController {
  let running = false
  let queuedResolvers: Array<() => void> = []

  async function reconcile(): Promise<void> {
    if (running) {
      // Queue this request; collect all waiters so none hang.
      // All waiters resolve when the next coalesced run completes (best-effort).
      return new Promise<void>((resolve) => {
        queuedResolvers.push(resolve)
      })
    }

    running = true
    try {
      await performReconciliation(deps)

      // Drain queued requests while holding the running lock.
      // This prevents a new caller from starting a concurrent run between
      // `running = false` and the queued reconciliation starting.
      while (queuedResolvers.length > 0) {
        const resolvers = queuedResolvers
        queuedResolvers = []
        try {
          await performReconciliation(deps)
        } catch (err) {
          // Best-effort: resolve waiters even on failure so their promises don't hang
          logger.error`Queued reconciliation failed: ${err}`
        }
        resolvers.forEach((r) => r())
      }
    } finally {
      running = false
    }
  }

  return { reconcile }
}
