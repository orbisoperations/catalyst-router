interface ServiceHealth {
  name: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export function ServiceCard({ service }: { service: ServiceHealth }) {
  const statusColor =
    service.status === 'up' ? '#22c55e' : service.status === 'down' ? '#ef4444' : '#94a3b8'

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '1rem',
        marginBottom: '0.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
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
    </div>
  )
}
