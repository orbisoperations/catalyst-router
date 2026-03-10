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
  // bus.ts — keepalive and sync events
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
  })
})
