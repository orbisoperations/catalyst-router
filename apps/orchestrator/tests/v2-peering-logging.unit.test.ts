import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that peering & reconnection log events
 * exist with the correct structured fields in the V2 orchestrator source.
 */
describe('V2 peering & reconnection logging', () => {
  const v2Dir = path.resolve(__dirname, '../src/v2')

  function readSource(filename: string): string {
    return fs.readFileSync(path.join(v2Dir, filename), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // reconnect.ts — reconnection lifecycle events
  // ---------------------------------------------------------------------------

  describe('reconnect.ts', () => {
    it('should log peer.reconnect.scheduled with reconnect.attempt and reconnect.delay_ms', () => {
      const src = readSource('reconnect.ts')
      expect(src).toContain("'event.name': 'peer.reconnect.scheduled'")
      expect(src).toContain("'catalyst.orchestrator.reconnect.attempt':")
      expect(src).toContain("'catalyst.orchestrator.reconnect.delay_ms':")
    })

    it('should log peer.reconnect.succeeded with reconnect.attempt', () => {
      const src = readSource('reconnect.ts')
      expect(src).toContain("'event.name': 'peer.reconnect.succeeded'")
      expect(src).toContain("'catalyst.orchestrator.reconnect.attempt':")
    })

    it('should log peer.reconnect.failed with reconnect.attempt', () => {
      const src = readSource('reconnect.ts')
      expect(src).toContain("'event.name': 'peer.reconnect.failed'")
      // reconnect.attempt is already asserted above; verify it co-occurs with the event
      const failedBlock = src.slice(
        src.indexOf('peer.reconnect.failed'),
        src.indexOf('peer.reconnect.failed') + 200
      )
      expect(failedBlock).toContain("'catalyst.orchestrator.reconnect.attempt':")
    })
  })

  // ---------------------------------------------------------------------------
  // bus.ts — keepalive and sync events + wide events
  // ---------------------------------------------------------------------------

  describe('bus.ts', () => {
    it('should log peer.keepalive.sent', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'peer.keepalive.sent'")
    })

    it('should log peer.sync.started', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'peer.sync.started'")
    })

    it('should log peer.sync.failed', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'peer.sync.failed'")
    })

    it('should emit orchestrator.gateway_sync wide event', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'orchestrator.gateway_sync'")
      expect(src).toContain("'catalyst.orchestrator.gateway.route_count'")
    })

    it('should emit orchestrator.envoy_sync wide event', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'orchestrator.envoy_sync'")
      expect(src).toContain("'catalyst.orchestrator.envoy.local_count'")
      expect(src).toContain("'catalyst.orchestrator.envoy.internal_count'")
    })
  })

  // ---------------------------------------------------------------------------
  // service.ts — journal recovery and auto-dial wide events
  // ---------------------------------------------------------------------------

  describe('service.ts', () => {
    it('should emit orchestrator.journal_recovery wide event', () => {
      const src = readSource('service.ts')
      expect(src).toContain("'orchestrator.journal_recovery'")
      expect(src).toContain("'catalyst.orchestrator.journal.mode'")
      expect(src).toContain("'catalyst.orchestrator.journal.replayed_entries'")
    })

    it('should emit orchestrator.auto_dial wide event', () => {
      const src = readSource('service.ts')
      expect(src).toContain("'orchestrator.auto_dial'")
      expect(src).toContain("'catalyst.orchestrator.peer.name'")
    })
  })

  // ---------------------------------------------------------------------------
  // catalyst-service.ts — token lifecycle wide events
  // ---------------------------------------------------------------------------

  describe('catalyst-service.ts', () => {
    it('should emit orchestrator.token_mint wide event', () => {
      const src = readSource('catalyst-service.ts')
      expect(src).toContain("'orchestrator.token_mint'")
      expect(src).toContain("'catalyst.orchestrator.auth.endpoint'")
    })

    it('should emit orchestrator.token_refresh wide event', () => {
      const src = readSource('catalyst-service.ts')
      expect(src).toContain("'orchestrator.token_refresh'")
    })
  })

  // ---------------------------------------------------------------------------
  // http-transport.ts — transport wide events (match ws-transport pattern)
  // ---------------------------------------------------------------------------

  describe('http-transport.ts', () => {
    it('should emit transport.open_peer wide event', () => {
      const src = readSource('http-transport.ts')
      expect(src).toContain("'transport.open_peer'")
      expect(src).toContain("'catalyst.orchestrator.peer.name'")
    })

    it('should emit transport.close_peer wide event', () => {
      const src = readSource('http-transport.ts')
      expect(src).toContain("'transport.close_peer'")
    })
  })
})
