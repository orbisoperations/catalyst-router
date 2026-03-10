import { useState, useEffect } from 'react'

export interface DashboardConfig {
  links: Record<string, string> | null
}

export function useConfig() {
  const [config, setConfig] = useState<DashboardConfig | null>(null)

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then(setConfig)
      .catch(() => {})
  }, [])

  return config
}
