export function Sidebar() {
  return (
    <aside
      style={{
        width: 240,
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-default)',
        display: 'flex',
        flexDirection: 'column',
        padding: '1.5rem 0',
        zIndex: 10,
      }}
    >
      {/* Logo + name */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.65rem',
          padding: '0 1.25rem',
          marginBottom: '2rem',
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.5"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: '1.15rem',
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          Catalyst
        </span>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1 }}>
        <SidebarSection label="System">
          <SidebarItem label="Status" active />
        </SidebarSection>
        <SidebarSection label="Monitoring">
          <SidebarItem label="Coming soon" disabled />
        </SidebarSection>
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: '0 1.25rem',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: 'var(--text-tertiary)',
          lineHeight: 1.6,
        }}
      >
        <div>Catalyst Router</div>
        <div style={{ opacity: 0.7 }}>&copy; 2026</div>
      </div>
    </aside>
  )
}

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.65rem',
          fontWeight: 500,
          color: 'var(--text-tertiary)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '0 1.25rem',
          marginBottom: '0.35rem',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

function SidebarItem({
  label,
  active,
  disabled,
}: {
  label: string
  active?: boolean
  disabled?: boolean
}) {
  return (
    <div
      style={{
        padding: '0.45rem 1.25rem',
        fontFamily: 'var(--font-display)',
        fontSize: '0.88rem',
        fontWeight: active ? 600 : 400,
        color: disabled
          ? 'var(--text-tertiary)'
          : active
            ? 'var(--primary)'
            : 'var(--text-secondary)',
        background: active ? 'var(--primary-light)' : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        borderLeft: active ? '3px solid var(--primary)' : '3px solid transparent',
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </div>
  )
}
