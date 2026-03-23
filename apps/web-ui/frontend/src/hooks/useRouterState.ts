import { useState, useEffect } from 'react'

export interface DataChannelDefinition {
  name: string
  endpoint?: string
  protocol: string
  region?: string
  tags?: string[]
  envoyPort?: number
  healthStatus?: 'up' | 'down'
  responseTimeMs?: number | null
  lastCheckedAt?: string
}

export interface PeerRecord {
  name: string
  endpoint?: string
  domains: string[]
  connectionStatus: 'initializing' | 'connected' | 'closed'
  lastConnected?: string
}

export interface InternalRoute extends DataChannelDefinition {
  peer: { name: string; endpoint?: string; domains: string[] }
  nodePath: string[]
  originNode?: string
}

export interface RouterState {
  routes: {
    local: DataChannelDefinition[]
    internal: InternalRoute[]
  }
  peers: PeerRecord[]
}

export function useRouterState(pollIntervalMs = 10000) {
  const [state, setState] = useState<RouterState | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const fetchState = async () => {
      try {
        const res = await fetch('/api/state')
        if (!res.ok) {
          if (active) {
            setError(`Orchestrator returned ${res.status}`)
            setLoading(false)
          }
          return
        }
        const body = await res.json()
        if (active) {
          setState(body.data)
          setLastUpdated(body.lastUpdated ?? null)
          setStale(body.stale === true)
          setLoading(false)
          setError(null)
        }
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    }

    fetchState()
    const interval = setInterval(fetchState, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollIntervalMs])

  return { state, loading, lastUpdated, stale, error }
}
