import type { MediaServerClient } from '../media/client.js'
import type { RemoteMediaRoute } from '../types.js'

/**
 * Reconciles remote media routes from the mesh into the local MediaMTX
 * instance as on-demand pull paths.
 *
 * When the orchestrator pushes a new set of remote media routes (via RPC),
 * the RelayManager diffs that desired state against what is currently
 * configured and issues add/remove calls to MediaMTX. Paths are created
 * with `sourceOnDemand: true` so the actual RTSP pull only starts when a
 * viewer connects, and tears down after 10 s of inactivity.
 */
export class RelayManager {
  private knownPaths = new Set<string>()

  constructor(private client: MediaServerClient) {}

  /**
   * Bring local MediaMTX paths in line with the desired remote routes.
   *
   * - Paths in `knownPaths` but absent from `desired` are removed (stale).
   * - Paths in `desired` are (re-)added with on-demand pull config.
   * - Safe to call repeatedly with the same input (idempotent).
   */
  async reconcile(desired: RemoteMediaRoute[]): Promise<void> {
    const desiredNames = new Set(desired.map((r) => r.name))

    // Remove stale paths
    for (const name of this.knownPaths) {
      if (!desiredNames.has(name)) {
        await this.client.removePath(name)
        this.knownPaths.delete(name)
      }
    }

    // Add missing paths
    for (const route of desired) {
      await this.client.addPath(route.name, {
        source: route.endpoint,
        sourceOnDemand: true,
        sourceOnDemandCloseAfter: '10s',
      })
      this.knownPaths.add(route.name)
    }
  }
}
