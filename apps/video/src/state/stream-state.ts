import type { RemoteMediaRoute, StreamListItem } from '../types.js'

interface LocalStream {
  name: string
  endpoint: string
  tags: string[]
}

export class StreamState {
  private local: Map<string, LocalStream> = new Map()
  private remote: RemoteMediaRoute[] = []

  addLocal(name: string, endpoint: string, tags: string[] = []): void {
    this.local.set(name, { name, endpoint, tags })
  }

  removeLocal(name: string): boolean {
    return this.local.delete(name)
  }

  setRemote(routes: RemoteMediaRoute[]): void {
    this.remote = routes
  }

  listLocal(): StreamListItem[] {
    return [...this.local.values()].map((s) => ({
      name: s.name,
      source: 'local' as const,
      protocols: { rtsp: s.endpoint },
      tags: s.tags,
      availability: 'local' as const,
    }))
  }

  listRemote(): StreamListItem[] {
    return this.remote.map((r) => ({
      name: r.name,
      source: 'remote' as const,
      protocols: { rtsp: r.endpoint },
      tags: r.tags ?? [],
      availability: 'remote' as const,
    }))
  }

  listAll(): StreamListItem[] {
    return [...this.listLocal(), ...this.listRemote()]
  }
}
