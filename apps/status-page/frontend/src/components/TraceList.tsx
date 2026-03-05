interface Trace {
  traceID: string
  spans: Array<{
    operationName: string
    duration: number
  }>
  duration: number
}

export function TraceList({ traces }: { traces: Trace[] }) {
  if (traces.length === 0) return <p style={{ color: '#94a3b8' }}>No traces yet</p>

  return (
    <div style={{ fontSize: '0.875rem' }}>
      {traces.map((trace) => (
        <div
          key={trace.traceID}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '0.25rem 0',
            borderBottom: '1px solid #f1f5f9',
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
            {trace.traceID.slice(0, 8)}
          </span>
          <span>{trace.spans[0]?.operationName ?? '(unknown)'}</span>
          <span style={{ color: '#64748b' }}>{trace.spans.length} spans</span>
          <span style={{ fontFamily: 'monospace' }}>{(trace.duration / 1000).toFixed(1)}ms</span>
        </div>
      ))}
    </div>
  )
}
