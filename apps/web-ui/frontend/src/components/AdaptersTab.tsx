import { useRouterState } from '../hooks/useRouterState'
import type { DataChannelDefinition, InternalRoute } from '../hooks/useRouterState'

type AdapterRow = DataChannelDefinition & { origin: string }

function toRows(state: {
  routes: { local: DataChannelDefinition[]; internal: InternalRoute[] }
}): AdapterRow[] {
  const rows: AdapterRow[] = []
  for (const route of state.routes.local) {
    rows.push({ ...route, origin: 'local' })
  }
  for (const route of state.routes.internal) {
    rows.push({ ...route, origin: route.originNode ?? route.peer.name })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

function StatusBadge({ status }: { status?: 'up' | 'down' | 'unknown' }) {
  const s = status ?? 'unknown'
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    up: { bg: 'var(--status-up-bg)', color: 'var(--status-up)', label: 'Up' },
    down: { bg: 'var(--status-down-bg)', color: 'var(--status-down)', label: 'Down' },
    unknown: { bg: 'var(--bg-elevated)', color: 'var(--status-unknown)', label: 'Unknown' },
  }
  const { bg, color, label } = styles[s]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: bg,
        color,
        padding: '2px 10px',
        borderRadius: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  )
}

function formatResponseTime(ms?: number | null): string {
  if (ms == null) return '—'
  return `${ms}ms`
}

function oldestLastChecked(rows: AdapterRow[]): string | null {
  let oldest: string | null = null
  for (const row of rows) {
    if (row.lastChecked) {
      if (!oldest || row.lastChecked < oldest) oldest = row.lastChecked
    }
  }
  return oldest
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 1000) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

const thStyle: React.CSSProperties = {
  textAlign: 'left' as const,
  padding: '0.6rem 1rem',
  color: 'var(--primary-dark)',
  fontWeight: 600,
  fontSize: '0.72rem',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}

const tdStyle: React.CSSProperties = {
  padding: '0.7rem 1rem',
}

export function AdaptersTab() {
  const { state, loading, error } = useRouterState()

  if (error) {
    return (
      <div
        style={{
          border: '1px solid var(--status-down-border)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--status-down-bg)',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--status-down)',
          }}
        >
          Failed to load adapters: {error}
        </p>
      </div>
    )
  }

  if (loading || !state) {
    return (
      <div style={{ padding: '3rem 0', textAlign: 'center' }}>
        <div
          style={{
            width: 28,
            height: 28,
            border: '2px solid var(--border-default)',
            borderTopColor: 'var(--primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 1rem',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          loading adapters...
        </p>
      </div>
    )
  }

  const rows = toRows(state)

  if (rows.length === 0) {
    return (
      <div
        style={{
          border: '1px dashed var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: '4rem 2rem',
          textAlign: 'center',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: '1.05rem',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          No Adapters
        </h3>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          No data channels registered on this node or peers
        </p>
      </div>
    )
  }

  const oldest = oldestLastChecked(rows)
  const nodeCount = new Set(rows.map((r) => r.origin)).size

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.82rem',
        }}
      >
        <thead>
          <tr
            style={{
              background: 'var(--primary-light)',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <th style={thStyle}>Data channel</th>
            <th style={thStyle}>Protocol</th>
            <th style={thStyle}>Endpoint</th>
            <th style={thStyle}>Origin</th>
            <th style={thStyle}>Status</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Response</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={`${row.origin}-${row.name}`}
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                animation: 'fadeInUp 0.3s ease both',
                animationDelay: `${i * 0.03}s`,
              }}
            >
              <td style={{ ...tdStyle, fontWeight: 500, color: 'var(--text-primary)' }}>
                {row.name}
              </td>
              <td style={{ ...tdStyle, color: 'var(--text-tertiary)' }}>{row.protocol}</td>
              <td
                style={{
                  ...tdStyle,
                  color: 'var(--text-tertiary)',
                  fontSize: '0.72rem',
                  maxWidth: 240,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.endpoint ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: 'var(--link)', fontSize: '0.78rem' }}>
                {row.origin}
              </td>
              <td style={tdStyle}>
                <StatusBadge status={row.healthStatus} />
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-tertiary)' }}>
                {formatResponseTime(row.responseTimeMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{
          padding: '0.6rem 1rem',
          display: 'flex',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          color: 'var(--text-tertiary)',
        }}
      >
        <span>
          {rows.length} adapter{rows.length !== 1 ? 's' : ''} across {nodeCount} node
          {nodeCount !== 1 ? 's' : ''}
        </span>
        {oldest && <span>Last checked: {relativeTime(oldest)}</span>}
      </div>
    </div>
  )
}
