import { useState } from 'react'
import type { ServiceGroup } from './hooks/useHealth'
import { useHealth } from './hooks/useHealth'
import { useRouterState } from './hooks/useRouterState'
import type { DataChannelDefinition, PeerRecord } from './hooks/useRouterState'
import { ServiceCard } from './components/ServiceCard'

type Tab = 'nodes' | 'adapters'

export function App() {
  const [tab, setTab] = useState<Tab>('nodes')

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <main
        style={{
          flex: 1,
          marginLeft: 240,
          padding: '2.5rem 2.5rem',
          maxWidth: 960,
        }}
      >
        <PageHeader />
        <TabBar tab={tab} onTabChange={setTab} />
        <div style={{ animation: 'fadeInUp 0.5s ease both', animationDelay: '0.15s' }}>
          {tab === 'nodes' ? <NodesTab /> : <AdaptersTab />}
        </div>
      </main>
    </div>
  )
}

function Sidebar() {
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

function PageHeader() {
  return (
    <header
      style={{
        marginBottom: '1.75rem',
        animation: 'fadeInUp 0.4s ease both',
      }}
    >
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: '1.5rem',
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
          lineHeight: 1.2,
          marginBottom: '0.25rem',
        }}
      >
        System Status
      </h1>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          fontWeight: 400,
          color: 'var(--text-tertiary)',
          letterSpacing: '0.02em',
        }}
      >
        Service health overview
      </span>
    </header>
  )
}

function TabBar({ tab, onTabChange }: { tab: Tab; onTabChange: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: 'nodes', label: 'Nodes' },
    { key: 'adapters', label: 'Adapters' },
  ]

  return (
    <nav
      style={{
        display: 'flex',
        gap: '2px',
        marginBottom: '1.75rem',
        borderBottom: '1px solid var(--border-default)',
        animation: 'fadeInUp 0.4s ease both',
        animationDelay: '0.05s',
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onTabChange(t.key)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: 'var(--font-display)',
            fontSize: '0.95rem',
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? 'var(--text-primary)' : 'var(--text-tertiary)',
            padding: '0.6rem 1rem',
            borderBottom: `2px solid ${tab === t.key ? 'var(--primary)' : 'transparent'}`,
            marginBottom: '-1px',
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}

function NodesTab() {
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

function StatusPill({ up, total }: { up: number; total: number }) {
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

function PeersSection({ peers }: { peers: PeerRecord[] }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.5rem',
        }}
      >
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
          Peers
        </span>
        <StatusPill
          up={peers.filter((p) => p.connectionStatus === 'connected').length}
          total={peers.length}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {peers.map((peer) => (
          <PeerCard key={peer.name} peer={peer} />
        ))}
      </div>
    </div>
  )
}

function PeerCard({ peer }: { peer: PeerRecord }) {
  const isConnected = peer.connectionStatus === 'connected'
  const statusColor = isConnected ? 'var(--status-up)' : 'var(--status-down)'
  const statusBg = isConnected ? 'var(--status-up-bg)' : 'var(--status-down-bg)'
  const statusBorder = isConnected ? 'var(--status-up-border)' : 'var(--status-down-border)'

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
          background: statusColor,
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
        {peer.name}
      </span>
      {peer.domains.length > 0 && (
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
          {peer.domains.join(', ')}
        </span>
      )}
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
        {peer.connectionStatus}
      </span>
    </div>
  )
}

function AdaptersTab() {
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
