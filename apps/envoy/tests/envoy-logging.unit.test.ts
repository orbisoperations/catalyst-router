import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that envoy data plane log events
 * exist with the correct structured fields in the source files.
 */
describe('Envoy data plane logging', () => {
  function readSource(relativePath: string): string {
    return fs.readFileSync(path.resolve(__dirname, '../src', relativePath), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // rpc/server.ts — xDS config diff logging
  // ---------------------------------------------------------------------------

  describe('rpc/server.ts — xDS config diff', () => {
    it('should log envoy.config.diff with xds.clusters_added', () => {
      const src = readSource('rpc/server.ts')
      expect(src).toContain("'event.name': 'envoy.config.diff'")
      expect(src).toContain("'xds.clusters_added':")
    })

    it('should log envoy.config.diff with xds.clusters_removed', () => {
      const src = readSource('rpc/server.ts')
      expect(src).toContain("'event.name': 'envoy.config.diff'")
      expect(src).toContain("'xds.clusters_removed':")
    })

    it('should log envoy.config.diff with xds.version', () => {
      const src = readSource('rpc/server.ts')
      const eventIdx = src.indexOf("'event.name': 'envoy.config.diff'")
      expect(eventIdx).toBeGreaterThan(-1)

      // xds.version should be near the event name
      const surrounding = src.slice(Math.max(0, eventIdx - 100), eventIdx + 300)
      expect(surrounding).toContain("'xds.version':")
    })

    it('should only log diff when a previous snapshot exists', () => {
      const src = readSource('rpc/server.ts')
      // The diff block should be guarded by a previousSnapshot check
      const diffIdx = src.indexOf("'event.name': 'envoy.config.diff'")
      expect(diffIdx).toBeGreaterThan(-1)

      const preceding = src.slice(Math.max(0, diffIdx - 500), diffIdx)
      expect(preceding).toContain('previousSnapshot')
    })
  })

  // ---------------------------------------------------------------------------
  // xds/control-plane.ts — repeated NACK detection
  // ---------------------------------------------------------------------------

  describe('xds/control-plane.ts — repeated NACK detection', () => {
    it('should log envoy.nack.repeated with xds.client_id', () => {
      const src = readSource('xds/control-plane.ts')
      expect(src).toContain("'event.name': 'envoy.nack.repeated'")
      expect(src).toContain("'xds.client_id':")
    })

    it('should log envoy.nack.repeated with xds.nack_count', () => {
      const src = readSource('xds/control-plane.ts')
      expect(src).toContain("'event.name': 'envoy.nack.repeated'")
      expect(src).toContain("'xds.nack_count':")
    })

    it('should log envoy.nack.repeated with xds.resource_type', () => {
      const src = readSource('xds/control-plane.ts')
      const eventIdx = src.indexOf("'event.name': 'envoy.nack.repeated'")
      expect(eventIdx).toBeGreaterThan(-1)

      const surrounding = src.slice(Math.max(0, eventIdx - 100), eventIdx + 300)
      expect(surrounding).toContain("'xds.resource_type':")
    })

    it('should track NACK counts with clientNackCounts map', () => {
      const src = readSource('xds/control-plane.ts')
      expect(src).toContain('clientNackCounts')
    })

    it('should only warn on repeated NACKs at threshold intervals', () => {
      const src = readSource('xds/control-plane.ts')
      // The repeated NACK log should be guarded by a threshold check
      const eventIdx = src.indexOf("'event.name': 'envoy.nack.repeated'")
      expect(eventIdx).toBeGreaterThan(-1)

      const preceding = src.slice(Math.max(0, eventIdx - 300), eventIdx)
      expect(preceding).toContain('nackCount >= 3')
      expect(preceding).toContain('nackCount % 3 === 0')
    })
  })
})
