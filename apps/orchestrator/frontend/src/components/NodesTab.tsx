import { useState } from 'react'
import type { ServiceGroup } from '../hooks/useHealth'
import { useHealth } from '../hooks/useHealth'
import { useRouterState } from '../hooks/useRouterState'
import { ServiceCard } from './ServiceCard'
import { PeersSection } from './PeersSection'

export function NodesTab() {
  const { groups, loading } = useHealth()
  const { state } = useRouterState()

  if (loading) {
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
          polling services...
        </p>
      </div>
    )
  }

  const totalUp = groups.reduce(
    (sum, g) => sum + g.services.filter((s) => s.status === 'up').length,
    0
  )
  const totalServices = groups.reduce((sum, g) => sum + g.services.length, 0)

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: '1.15rem',
              color: 'var(--text-primary)',
            }}
          >
            Services
          </h2>
          <StatusPill up={totalUp} total={totalServices} />
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85rem',
            color: 'var(--text-tertiary)',
          }}
        >
          {totalServices} registered
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {groups.map((group, gi) => (
          <ServiceGroupSection key={group.name} group={group} index={gi} />
        ))}
      </div>

      {/* Peers section */}
      {state && state.peers.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <PeersSection peers={state.peers} />
        </div>
      )}
    </div>
  )
}

function ServiceGroupSection({ group, index }: { group: ServiceGroup; index: number }) {
  const [collapsed, setCollapsed] = useState(false)
  const upCount = group.services.filter((s) => s.status === 'up').length

  return (
    <div style={{ animation: 'fadeInUp 0.4s ease both', animationDelay: `${index * 0.08}s` }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: collapsed ? 0 : '0.5rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          style={{
            transition: 'transform 0.2s ease',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            fontWeight: 500,
            color: 'var(--text-tertiary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {group.name}
        </span>
        <StatusPill up={upCount} total={group.services.length} />
      </div>
      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {group.services.map((s, i) => (
            <div
              key={s.name}
              style={{ animation: 'fadeInUp 0.3s ease both', animationDelay: `${i * 0.04}s` }}
            >
              <ServiceCard service={s} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function StatusPill({ up, total }: { up: number; total: number }) {
  const allUp = up === total
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        fontWeight: 500,
        color: allUp ? 'var(--status-up)' : 'var(--status-down)',
        background: allUp ? 'var(--status-up-bg)' : 'var(--status-down-bg)',
        border: `1px solid ${allUp ? 'var(--status-up-border)' : 'var(--status-down-border)'}`,
        padding: '3px 8px',
        borderRadius: '4px',
        letterSpacing: '0.04em',
      }}
    >
      {up}/{total} operational
    </span>
  )
}
