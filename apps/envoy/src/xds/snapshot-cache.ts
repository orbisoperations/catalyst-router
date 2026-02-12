import type { XdsListener, XdsCluster } from './resources.js'

/**
 * xDS snapshot — a complete set of Envoy resources at a given version.
 *
 * The `listeners` and `clusters` arrays contain typed objects matching the
 * Envoy xDS JSON structure. The gRPC ADS server (future phase) will serialize
 * these into protobuf `DiscoveryResponse` messages.
 */
export interface XdsSnapshot {
  /** Monotonic version string. */
  version: string
  /** All LDS resources (ingress + egress listeners). */
  listeners: XdsListener[]
  /** All CDS resources (local + remote clusters). */
  clusters: XdsCluster[]
}

export interface SnapshotCache {
  /** Set a new snapshot. Notifies all connected watchers. */
  setSnapshot(snapshot: XdsSnapshot): void

  /** Get the current snapshot. */
  getSnapshot(): XdsSnapshot | undefined

  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  watch(callback: (snapshot: XdsSnapshot) => void): () => void
}

/**
 * Create an in-memory snapshot cache.
 *
 * Connects the Capnweb RPC input (from the Orchestrator) to the gRPC output
 * (to Envoy). When a new snapshot is set, all watchers are notified
 * synchronously.
 */
export function createSnapshotCache(): SnapshotCache {
  let current: XdsSnapshot | undefined
  const watchers = new Set<(snapshot: XdsSnapshot) => void>()

  return {
    setSnapshot(snapshot: XdsSnapshot): void {
      current = snapshot
      for (const callback of watchers) {
        callback(snapshot)
      }
    },

    getSnapshot(): XdsSnapshot | undefined {
      return current
    },

    watch(callback: (snapshot: XdsSnapshot) => void): () => void {
      watchers.add(callback)
      // Immediately replay the current snapshot to new watchers (BehaviorSubject pattern).
      // This ensures late-connecting ADS streams receive the latest config.
      if (current) {
        callback(current)
      }
      return () => {
        watchers.delete(callback)
      }
    },
  }
}
