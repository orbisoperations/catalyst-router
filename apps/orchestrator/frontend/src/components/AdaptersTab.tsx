import { useRouterState } from '../hooks/useRouterState'
import type { DataChannelDefinition } from '../hooks/useRouterState'

export function AdaptersTab() {
  const { state, loading } = useRouterState()

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

  const localRoutes = state.routes.local

  if (localRoutes.length === 0) {
    return (
      <div
        style={{
          border: '1px dashed var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: '4rem 2rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem',
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-tertiary)"
            strokeWidth="1.5"
          >
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
          </svg>
        </div>
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
          No local routes registered on this node
        </p>
      </div>
    )
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1.25rem',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: '1.15rem',
            color: 'var(--text-primary)',
          }}
        >
          Local Routes
        </h2>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          {localRoutes.length} registered
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {localRoutes.map((route, i) => (
          <div
            key={route.name}
            style={{ animation: 'fadeInUp 0.3s ease both', animationDelay: `${i * 0.04}s` }}
          >
            <AdapterCard route={route} />
          </div>
        ))}
      </div>
    </div>
  )
}

function AdapterCard({ route }: { route: DataChannelDefinition }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: '1.1rem 1.25rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--status-up)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.95rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
          letterSpacing: '0.01em',
        }}
      >
        {route.name}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          color: 'var(--text-tertiary)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {route.protocol}
      </span>
      {route.endpoint && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            color: 'var(--text-tertiary)',
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {route.endpoint}
        </span>
      )}
    </div>
  )
}
