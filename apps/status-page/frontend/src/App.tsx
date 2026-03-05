import { useState } from 'react'

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
  return (
    <div>
      <h2>Node Services</h2>
      <p>Health, logs, metrics, and traces for each Catalyst service.</p>
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
