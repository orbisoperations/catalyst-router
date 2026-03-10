import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that route exchange & convergence log events
 * exist with the correct structured fields in the V2 orchestrator source.
 */
describe('V2 route exchange & convergence logging', () => {
  const v2Dir = path.resolve(__dirname, '../src/v2')

  function readSource(filename: string): string {
    return fs.readFileSync(path.join(v2Dir, filename), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // bus.ts — route table change events
  // ---------------------------------------------------------------------------

  describe('bus.ts — route.table.changed', () => {
    it('should log route.table.changed with route.added, route.removed, route.modified, route.trigger, route.total', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'route.table.changed'")
      expect(src).toContain("'catalyst.orchestrator.route.added':")
      expect(src).toContain("'catalyst.orchestrator.route.removed':")
      expect(src).toContain("'catalyst.orchestrator.route.modified':")
      expect(src).toContain("'catalyst.orchestrator.route.trigger':")
      expect(src).toContain("'catalyst.orchestrator.route.total':")
    })
  })

  // ---------------------------------------------------------------------------
  // bus.ts — route sync empty event
  // ---------------------------------------------------------------------------

  describe('bus.ts — route.sync.empty', () => {
    it('should log route.sync.empty with peer.name', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'route.sync.empty'")
      // Verify peer.name co-occurs with the event
      const emptyBlock = src.slice(
        src.indexOf('route.sync.empty'),
        src.indexOf('route.sync.empty') + 200
      )
      expect(emptyBlock).toContain("'catalyst.orchestrator.peer.name':")
    })
  })

  // ---------------------------------------------------------------------------
  // bus.ts — route sync completed event
  // ---------------------------------------------------------------------------

  describe('bus.ts — route.sync.completed', () => {
    it('should log route.sync.completed with peer.name and route.count', () => {
      const src = readSource('bus.ts')
      expect(src).toContain("'event.name': 'route.sync.completed'")
      // Verify peer.name and route.count co-occur with the event
      const completedBlock = src.slice(
        src.indexOf('route.sync.completed'),
        src.indexOf('route.sync.completed') + 200
      )
      expect(completedBlock).toContain("'catalyst.orchestrator.peer.name':")
      expect(completedBlock).toContain("'catalyst.orchestrator.route.count':")
    })
  })
})
