function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function LinkIcon({ type }: { type: string }) {
  const lower = type.toLowerCase()
  if (lower === 'metrics') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <path d="M18 20V10M12 20V4M6 20v-6" />
      </svg>
    )
  }
  if (lower === 'traces') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    )
  }
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

export function ObservabilityLinks({
  otelName,
  links,
}: {
  otelName: string
  links: Record<string, string>
}) {
  const entries = Object.entries(links)
  if (entries.length === 0) return null

  return (
    <div
      style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: '0.75rem 1.25rem',
        display: 'flex',
        gap: '0.5rem',
        animation: 'slide-down 0.3s ease both',
      }}
    >
      {entries.map(([label, template]) => (
        <a
          key={label}
          href={template.replace(/\{service\}/g, otelName)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            fontWeight: 500,
            color: 'var(--link)',
            background: '#f2f6ff',
            border: '1px solid var(--border-subtle)',
            padding: '0.4rem 0.75rem',
            borderRadius: 'var(--radius-sm)',
            textDecoration: 'none',
            transition: 'background 0.15s ease, border-color 0.15s ease',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--primary-light)'
            e.currentTarget.style.borderColor = 'var(--border-default)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#f2f6ff'
            e.currentTarget.style.borderColor = 'var(--border-subtle)'
          }}
        >
          <LinkIcon type={label} />
          {capitalize(label)}
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      ))}
    </div>
  )
}
