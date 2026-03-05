import { useState, useEffect } from 'react'

interface Trace {
  traceID: string
  spans: Array<{
    operationName: string
    duration: number
    tags: Array<{ key: string; value: string }>
  }>
  duration: number
}

export function useTraces(serviceName: string, limit = 20, pollIntervalMs = 10000) {
  const [traces, setTraces] = useState<Trace[]>([])

  useEffect(() => {
    let active = true
    const fetchTraces = async () => {
      const params = new URLSearchParams({
        service: serviceName,
        limit: String(limit),
        lookback: '1h',
      })

      try {
        const res = await fetch(`/api/traces/traces?${params}`)
        const json = await res.json()
        if (active && json.data) {
          setTraces(json.data)
        }
      } catch {
        /* ignore */
      }
    }

    fetchTraces()
    const interval = setInterval(fetchTraces, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [serviceName, limit, pollIntervalMs])

  return traces
}
