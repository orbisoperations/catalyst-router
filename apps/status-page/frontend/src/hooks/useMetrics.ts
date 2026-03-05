import { useState, useEffect } from 'react'

interface MetricPoint {
  timestamp: number
  value: number
}

export function useMetrics(query: string, pollIntervalMs = 15000) {
  const [data, setData] = useState<MetricPoint[]>([])

  useEffect(() => {
    let active = true
    const fetchMetrics = async () => {
      const end = Math.floor(Date.now() / 1000)
      const start = end - 3600 // last hour
      const params = new URLSearchParams({
        query,
        start: String(start),
        end: String(end),
        step: '60',
      })

      try {
        const res = await fetch(`/api/metrics/query_range?${params}`)
        const json = await res.json()
        if (active && json.data?.result?.[0]?.values) {
          setData(
            json.data.result[0].values.map(([t, v]: [number, string]) => ({
              timestamp: t,
              value: parseFloat(v),
            }))
          )
        }
      } catch {
        /* ignore fetch errors */
      }
    }

    fetchMetrics()
    const interval = setInterval(fetchMetrics, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [query, pollIntervalMs])

  return data
}
