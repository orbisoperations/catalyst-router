interface LogEntry {
  timestamp: string
  severity: string
  body: string
}

const SEVERITY_COLORS: Record<string, string> = {
  ERROR: '#ef4444',
  WARN: '#f59e0b',
  INFO: '#3b82f6',
  DEBUG: '#94a3b8',
}

export function LogStream({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) return <p style={{ color: '#94a3b8' }}>No logs yet</p>

  return (
    <div
      style={{
        fontFamily: 'monospace',
        fontSize: '0.75rem',
        maxHeight: '300px',
        overflowY: 'auto',
        backgroundColor: '#0f172a',
        color: '#e2e8f0',
        padding: '0.5rem',
        borderRadius: '4px',
      }}
    >
      {logs.map((log, i) => (
        <div key={i} style={{ marginBottom: '2px' }}>
          <span style={{ color: '#64748b' }}>{log.timestamp}</span>{' '}
          <span style={{ color: SEVERITY_COLORS[log.severity] ?? '#94a3b8' }}>{log.severity}</span>{' '}
          {log.body}
        </div>
      ))}
    </div>
  )
}
