import { useState } from 'react'
import { useHealth } from './hooks/useHealth'
import { ServiceCard } from './components/ServiceCard'

type Tab = 'nodes' | 'adapters'

export function App() {
  const [tab, setTab] = useState<Tab>('nodes')

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <h1>Catalyst Status</h1>
      <nav style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <button
          onClick={() => setTab('nodes')}
          style={{ fontWeight: tab === 'nodes' ? 'bold' : 'normal' }}
        >
          Nodes
        </button>
        <button
          onClick={() => setTab('adapters')}
          style={{ fontWeight: tab === 'adapters' ? 'bold' : 'normal' }}
        >
          Adapters
        </button>
      </nav>
      {tab === 'nodes' ? <NodesTab /> : <AdaptersPlaceholder />}
    </div>
  )
}

function NodesTab() {
  const { services, loading } = useHealth()

  if (loading) return <p>Loading...</p>

  return (
    <div>
      <h2>Node Services</h2>
      {services.map((s) => (
        <ServiceCard key={s.name} service={s} />
      ))}
    </div>
  )
}

function AdaptersPlaceholder() {
  return (
    <div>
      <h2>Adapters</h2>
      <p>Coming soon — per-adapter observability.</p>
    </div>
  )
}
