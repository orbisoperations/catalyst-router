import type { InternalRoute, RouteTable } from './state.js'

/**
 * Compare two internal routes for best-path selection (RFC 4271 §9.1.2.2).
 *
 * Returns negative if `a` is preferred, positive if `b` is preferred, 0 if tied.
 *
 * Tiebreaker order:
 *   1. Non-stale beats stale (RFC 4724)
 *   2. Non-draining beats draining (RFC 8326)
 *   3. Shorter nodePath wins (analogous to AS_PATH length)
 *   4. Lowest peer name wins (deterministic tiebreaker, analogous to Router ID)
 */
export function comparePaths(a: InternalRoute, b: InternalRoute): number {
  // 1. Staleness: non-stale preferred
  const aStale = a.isStale === true ? 1 : 0
  const bStale = b.isStale === true ? 1 : 0
  if (aStale !== bStale) return aStale - bStale

  // 2. Drain status: non-draining preferred
  const aDrain = a.draining === true ? 1 : 0
  const bDrain = b.draining === true ? 1 : 0
  if (aDrain !== bDrain) return aDrain - bDrain

  // 3. Path length: shorter preferred
  const pathDiff = a.nodePath.length - b.nodePath.length
  if (pathDiff !== 0) return pathDiff

  // 4. Deterministic tiebreaker: lowest peer name
  if (a.peer.name < b.peer.name) return -1
  if (a.peer.name > b.peer.name) return 1

  return 0
}

/**
 * Scan all peers' Adj-RIB-In for the given irKey and return the peer name
 * whose route wins best-path selection. Returns undefined if no peer has
 * a route for this irKey.
 */
export function selectBestPeer(
  routes: RouteTable['internal']['routes'],
  irKey: string
): string | undefined {
  let bestPeer: string | undefined
  let bestRoute: InternalRoute | undefined

  for (const [peerName, innerMap] of routes) {
    const candidate = innerMap.get(irKey)
    if (candidate === undefined) continue
    if (bestRoute === undefined || comparePaths(candidate, bestRoute) < 0) {
      bestPeer = peerName
      bestRoute = candidate
    }
  }

  return bestPeer
}
