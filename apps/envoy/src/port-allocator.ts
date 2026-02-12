import type { PortEntry } from '@catalyst/config'

export interface PortAllocator {
  /** Allocate a port for a data channel. Idempotent -- returns existing allocation. */
  allocate(channelName: string): { success: true; port: number } | { success: false; error: string }

  /** Release a previously allocated port. */
  release(channelName: string): void

  /** Get the port for a channel, if allocated. */
  getPort(channelName: string): number | undefined

  /** Get all current allocations. */
  getAllocations(): ReadonlyMap<string, number>

  /** Number of ports remaining in the pool. */
  availableCount(): number
}

/**
 * Expand a PortEntry array into a flat list of individual port numbers.
 *
 * Single ports pass through unchanged. Tuple ranges [start, end] expand
 * into every integer from start to end inclusive.
 */
export function expandPortRange(entries: PortEntry[]): number[] {
  const ports: number[] = []
  for (const entry of entries) {
    if (typeof entry === 'number') {
      ports.push(entry)
    } else {
      const [start, end] = entry
      for (let port = start; port <= end; port++) {
        ports.push(port)
      }
    }
  }
  return ports
}

/**
 * Create a port allocator from a PortEntry array.
 *
 * Optionally accepts existing allocations (Map<string, number>) for restart
 * recovery. Re-hydrated ports are reserved in the pool before any new
 * allocations are made.
 */
export function createPortAllocator(
  portRange: PortEntry[],
  existing?: Map<string, number>
): PortAllocator {
  const pool = expandPortRange(portRange)
  const available = new Set<number>(pool)
  const allocations = new Map<string, number>()

  // Re-hydrate existing allocations
  if (existing) {
    for (const [name, port] of existing) {
      allocations.set(name, port)
      available.delete(port)
    }
  }

  return {
    allocate(channelName: string) {
      // Idempotent: return existing allocation
      const existing = allocations.get(channelName)
      if (existing !== undefined) {
        return { success: true, port: existing }
      }

      // Find next available port
      const next = available.values().next()
      if (next.done) {
        return { success: false, error: 'No ports available' }
      }

      const port = next.value
      available.delete(port)
      allocations.set(channelName, port)
      return { success: true, port }
    },

    release(channelName: string) {
      const port = allocations.get(channelName)
      if (port === undefined) return
      allocations.delete(channelName)
      available.add(port)
    },

    getPort(channelName: string) {
      return allocations.get(channelName)
    },

    getAllocations() {
      return allocations as ReadonlyMap<string, number>
    },

    availableCount() {
      return available.size
    },
  }
}
