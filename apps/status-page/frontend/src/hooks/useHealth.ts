import { useState, useEffect } from 'react'

interface ServiceHealth {
  name: string
  url: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export function useHealth(pollIntervalMs = 10000) {
  const [services, setServices] = useState<ServiceHealth[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/services')
        const data = await res.json()
        if (active) {
          setServices(data.services)
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

  return { services, loading }
}
