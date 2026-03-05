import { useState, useEffect } from 'react'

interface LogEntry {
  timestamp: string
  severity: string
  body: string
  attributes: Record<string, string>
}

export function useLogs(serviceName: string, limit = 50, pollIntervalMs = 5000) {
  const [logs, setLogs] = useState<LogEntry[]>([])

  useEffect(() => {
    let active = true
    const fetchLogs = async () => {
      const query = `from(bucket: "logs")
        |> range(start: -1h)
        |> filter(fn: (r) => r["service.name"] == "${serviceName}")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: ${limit})`

      try {
        const res = await fetch('/api/logs/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        })
        const text = await res.text()
        if (active) {
          setLogs(parseInfluxResponse(text))
        }
      } catch {
        /* ignore */
      }
    }

    fetchLogs()
    const interval = setInterval(fetchLogs, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [serviceName, limit, pollIntervalMs])

  return logs
}

function parseInfluxResponse(csv: string): LogEntry[] {
  // InfluxDB returns annotated CSV. Parse rows into LogEntry objects.
  const lines = csv.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith(','))
  return lines.slice(0, 50).map((line) => {
    const parts = line.split(',')
    return {
      timestamp: parts[5] ?? '',
      severity: parts[6] ?? 'INFO',
      body: parts[7] ?? line,
      attributes: {},
    }
  })
}
