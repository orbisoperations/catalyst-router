import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { NodesTab } from './components/NodesTab'
import { AdaptersTab } from './components/AdaptersTab'

type Tab = 'services' | 'adapters'

export function App() {
  const [tab, setTab] = useState<Tab>('services')

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
          {tab === 'services' ? <NodesTab /> : <AdaptersTab />}
        </div>
      </main>
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
    { key: 'services', label: 'Services' },
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
