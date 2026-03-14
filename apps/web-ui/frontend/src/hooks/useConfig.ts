import { useState, useEffect } from 'react'

export interface DashboardConfig {
  links: Record<string, string> | null
}

export function useConfig() {
  const [config, setConfig] = useState<DashboardConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        setConfig(data)
        setError(null)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return { config, error }
}
