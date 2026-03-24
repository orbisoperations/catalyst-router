import { getLogger } from '@catalyst/telemetry'

const logger = getLogger(['catalyst', 'video', 'session'])

/**
 * Active subscriber session metadata. Stored in-memory only — sessions are
 * ephemeral and do not survive service restarts (Constitution X exception
 * for ephemeral caches).
 *
 * The raw JWT is NOT stored. Only the `exp` claim is retained for the O(1)
 * sweep check. This avoids unnecessary credential exposure in memory
 * (Constitution XV).
 */
export interface SessionEntry {
  /** MediaMTX session ID (unique per connection). */
  id: string
  /** Stream path the session is connected to. */
  path: string
  /** Protocol used: 'rtsp' | 'rtmp' | 'hls'. */
  protocol: 'rtsp' | 'rtmp' | 'hls'
  /** Token expiry in ms since epoch (decoded from JWT `exp` claim). */
  exp: number
  /** Timestamp when the session was recorded (ms since epoch). */
  recordedAt: number
}

/**
 * In-memory registry of active subscriber sessions.
 *
 * Source of truth for "which subscribers are currently connected with which
 * metadata." The revalidation sweep iterates this registry to find expired
 * sessions. The runOnUnread lifecycle hook removes entries on disconnect.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>()
  /** Reverse index: path → set of session IDs. Keeps getByPath O(1). */
  private readonly pathIndex = new Map<string, Set<string>>()

  add(entry: SessionEntry): void {
    const existing = this.sessions.get(entry.id)
    if (existing && existing.path !== entry.path) {
      this.removeFromPathIndex(existing.id, existing.path)
    }
    this.sessions.set(entry.id, entry)
    let ids = this.pathIndex.get(entry.path)
    if (!ids) {
      ids = new Set()
      this.pathIndex.set(entry.path, ids)
    }
    ids.add(entry.id)
    logger.debug('Session registered: {id} on {path} ({protocol})', {
      'event.name': 'video.session.registered',
      id: entry.id,
      path: entry.path,
      protocol: entry.protocol,
    })
  }

  remove(id: string): boolean {
    const entry = this.sessions.get(id)
    if (!entry) return false
    this.sessions.delete(id)
    this.removeFromPathIndex(id, entry.path)
    logger.debug('Session deregistered: {id}', {
      'event.name': 'video.session.deregistered',
      id,
    })
    return true
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id)
  }

  getByPath(path: string): SessionEntry[] {
    const ids = this.pathIndex.get(path)
    if (!ids || ids.size === 0) return []
    const result: SessionEntry[] = []
    for (const id of ids) {
      const entry = this.sessions.get(id)
      if (entry) result.push(entry)
    }
    return result
  }

  entries(): IterableIterator<SessionEntry> {
    return this.sessions.values()
  }

  get size(): number {
    return this.sessions.size
  }

  clear(): void {
    this.sessions.clear()
    this.pathIndex.clear()
  }

  private removeFromPathIndex(id: string, path: string): void {
    const ids = this.pathIndex.get(path)
    if (ids) {
      ids.delete(id)
      if (ids.size === 0) this.pathIndex.delete(path)
    }
  }
}
