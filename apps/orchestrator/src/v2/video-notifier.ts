import { z } from 'zod'
import type { RouteTable, RouteChange } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Schemas — Zod-first (Constitution VII)
// ---------------------------------------------------------------------------

export const StreamEntrySchema = z.object({
  name: z.string(),
  protocol: z.string(),
  endpoint: z.string().optional(),
  source: z.enum(['local', 'remote']),
  sourceNode: z.string(),
  metadata: z.record(z.unknown()).optional(),
  nodePath: z.array(z.string()).optional(),
})
export type StreamEntry = z.infer<typeof StreamEntrySchema>

export const StreamCatalogSchema = z.object({
  streams: z.array(StreamEntrySchema),
})
export type StreamCatalog = z.infer<typeof StreamCatalogSchema>

// ---------------------------------------------------------------------------
// VideoNotifier interface (Constitution IV — Dependency Inversion)
// ---------------------------------------------------------------------------

export interface VideoNotifier {
  pushCatalog(catalog: StreamCatalog): Promise<void>
}

// ---------------------------------------------------------------------------
// Pure functions — projection and change detection
// ---------------------------------------------------------------------------

/**
 * Project a RouteTable into a StreamCatalog containing only media routes.
 *
 * Local routes → source: 'local', sourceNode = nodeId
 * Internal routes → source: 'remote', sourceNode = originNode
 * Stale internal routes are excluded.
 */
export function buildStreamCatalog(nodeId: string, state: RouteTable): StreamCatalog {
  const streams: StreamEntry[] = []

  // Local media routes
  for (const route of state.local.routes) {
    if (route.protocol !== 'media') continue
    const entry: StreamEntry = {
      name: route.name,
      protocol: route.protocol,
      source: 'local',
      sourceNode: nodeId,
    }
    if (route.endpoint !== undefined) entry.endpoint = route.endpoint
    streams.push(entry)
  }

  // Internal media routes (non-stale only)
  for (const route of state.internal.routes) {
    if (route.protocol !== 'media') continue
    if (route.isStale === true) continue
    const entry: StreamEntry = {
      name: route.name,
      protocol: route.protocol,
      source: 'remote',
      sourceNode: route.originNode,
      nodePath: route.nodePath,
    }
    if (route.endpoint !== undefined) entry.endpoint = route.endpoint
    streams.push(entry)
  }

  return { streams }
}

/** Check whether any route change involves a media-protocol route. */
export function hasMediaRouteChanges(changes: RouteChange[]): boolean {
  return changes.some((change) => change.route.protocol === 'media')
}
