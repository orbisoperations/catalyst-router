import { useState } from 'react'
import type { ServiceHealth } from '../hooks/useHealth'
import { useConfig } from '../hooks/useConfig'
import { ObservabilityLinks } from './ObservabilityLinks'

export function ServiceCard({ service }: { service: ServiceHealth }) {
  const [expanded, setExpanded] = useState(false)
  const { config } = useConfig()

  const isUp = service.status === 'up'
  const isDown = service.status === 'down'
  const statusColor = isUp
    ? 'var(--status-up)'
    : isDown
      ? 'var(--status-down)'
      : 'var(--status-unknown)'
  const statusBg = isUp ? 'var(--status-up-bg)' : isDown ? 'var(--status-down-bg)' : 'transparent'
  const statusBorder = isUp
    ? 'var(--status-up-border)'
    : isDown
      ? 'var(--status-down-border)'
      : 'var(--border-default)'

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${expanded ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
        boxShadow: expanded ? 'var(--shadow)' : 'none',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => {
          if (!expanded) e.currentTarget.style.background = 'var(--bg-hover)'
        }}
        onMouseLeave={(e) => {
          if (!expanded) e.currentTarget.style.background = 'transparent'
        }}
        style={{
          padding: '1.1rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'background 0.15s ease',
        }}
      >
        {/* Status dot */}
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: statusColor,
            flexShrink: 0,
          }}
        />

        {/* Service name */}
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
          {service.name}
        </span>

        {/* Latency badge */}
        {service.durationMs !== undefined && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              color: 'var(--text-tertiary)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              padding: '3px 9px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {service.durationMs}ms
          </span>
        )}

        {/* Status pill */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            fontWeight: 500,
            color: statusColor,
            background: statusBg,
            border: `1px solid ${statusBorder}`,
            padding: '2px 8px',
            borderRadius: '12px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {service.status}
        </span>

        {/* Chevron */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            transition: 'transform 0.25s ease',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
            flexShrink: 0,
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {expanded && config?.links && (
        <ObservabilityLinks otelName={service.otelName} links={config.links} />
      )}
    </div>
  )
}
