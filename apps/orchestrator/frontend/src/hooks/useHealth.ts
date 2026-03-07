import { useState, useEffect } from 'react'

export interface ServiceHealth {
  name: string
  otelName: string
  url: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export interface ServiceGroup {
  name: string
  services: ServiceHealth[]
}

export function useHealth(pollIntervalMs = 10000) {
  const [groups, setGroups] = useState<ServiceGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const fetchHealth = async () => {
      try {
        const res = await fetch('/dashboard/api/services')
        const data = await res.json()
        if (active) {
          setGroups(data.groups)
          setLoading(false)
        }
      } catch {
        if (active) setLoading(false)
      }
    }

    fetchHealth()
    const interval = setInterval(fetchHealth, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollIntervalMs])

  return { groups, loading }
}
