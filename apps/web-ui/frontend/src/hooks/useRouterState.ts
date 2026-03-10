import { useState, useEffect } from 'react'

export interface DataChannelDefinition {
  name: string
  endpoint?: string
  protocol: string
  region?: string
  tags?: string[]
  envoyPort?: number
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const fetchState = async () => {
      try {
        const res = await fetch('/api/state')
        const data = await res.json()
        if (active) {
          setState(data)
          setLoading(false)
        }
      } catch {
        if (active) setLoading(false)
      }
    }

    fetchState()
    const interval = setInterval(fetchState, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollIntervalMs])

  return { state, loading }
}
