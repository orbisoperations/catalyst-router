import { useState } from 'react'
import { useMetrics } from '../hooks/useMetrics'
import { useLogs } from '../hooks/useLogs'
import { useTraces } from '../hooks/useTraces'
import { Sparkline } from './MetricsChart'
import { LogStream } from './LogStream'
import { TraceList } from './TraceList'

interface ServiceHealth {
  name: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export function ServiceCard({ service }: { service: ServiceHealth }) {
  const [expanded, setExpanded] = useState(false)
  const statusColor =
    service.status === 'up' ? '#22c55e' : service.status === 'down' ? '#ef4444' : '#94a3b8'

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        marginBottom: '0.5rem',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            backgroundColor: statusColor,
          }}
        />
        <div style={{ flex: 1 }}>
          <strong>{service.name}</strong>
          {service.latencyMs !== undefined && (
            <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.875rem' }}>
              {service.latencyMs}ms
            </span>
          )}
        </div>
        <span
          style={{
            color: statusColor,
            fontWeight: 600,
            textTransform: 'uppercase',
            fontSize: '0.75rem',
          }}
        >
          {service.status}
        </span>
        <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && <ServiceDetails name={service.name} />}
    </div>
  )
}

function ServiceDetails({ name }: { name: string }) {
  const requestRate = useMetrics(
    `rate(http_server_request_duration_seconds_count{service_name="${name}"}[5m])`
  )
  const errorRate = useMetrics(
    `rate(http_server_request_duration_seconds_count{service_name="${name}",http_response_status_code=~"5.."}[5m])`,
    15000
  )
  const logs = useLogs(name)
  const traces = useTraces(name)

  return (
    <div style={{ padding: '0 1rem 1rem', borderTop: '1px solid #f1f5f9' }}>
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}
      >
        <div>
          <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            Request Rate (5m)
          </h4>
          <Sparkline data={requestRate} color="#3b82f6" />
        </div>
        <div>
          <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            Error Rate (5m)
          </h4>
          <Sparkline data={errorRate} color="#ef4444" />
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
          Recent Logs
        </h4>
        <LogStream logs={logs} />
      </div>

      <div style={{ marginTop: '1rem' }}>
        <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
          Recent Traces
        </h4>
        <TraceList traces={traces} />
      </div>
    </div>
  )
}
