import type { PeerRecord } from '../hooks/useRouterState'
import { StatusPill } from './NodesTab'

export function PeersSection({ peers }: { peers: PeerRecord[] }) {
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
