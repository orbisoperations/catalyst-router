import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that gateway federation log events
 * exist with the correct structured fields in the gateway source.
 */
describe('Gateway federation logging', () => {
  const graphqlDir = path.resolve(__dirname, '../src/graphql')

  function readSource(filename: string): string {
    return fs.readFileSync(path.join(graphqlDir, filename), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // server.ts — SDL validation events
  // ---------------------------------------------------------------------------

  describe('server.ts — SDL validation', () => {
    it('should log gateway.subgraph.sdl_validated on success with subgraph.name and valid: true', () => {
      const src = readSource('server.ts')
      expect(src).toContain("'event.name': 'gateway.subgraph.sdl_validated'")
      expect(src).toContain("'subgraph.name':")

      // Find the success block (valid: true) near the event name
      const successIdx = src.indexOf('valid: true')
      expect(successIdx).toBeGreaterThan(-1)

      // The success log should be near a gateway.subgraph.sdl_validated event
      const surroundingSuccess = src.slice(Math.max(0, successIdx - 200), successIdx + 100)
      expect(surroundingSuccess).toContain("'event.name': 'gateway.subgraph.sdl_validated'")
      expect(surroundingSuccess).toContain("'subgraph.name':")
    })

    it('should log gateway.subgraph.sdl_validated on failure with valid: false and error.message', () => {
      const src = readSource('server.ts')

      // Find the failure block (valid: false) near the event name
      const failureIdx = src.indexOf('valid: false')
      expect(failureIdx).toBeGreaterThan(-1)

      const surroundingFailure = src.slice(Math.max(0, failureIdx - 200), failureIdx + 200)
      expect(surroundingFailure).toContain("'event.name': 'gateway.subgraph.sdl_validated'")
      expect(surroundingFailure).toContain("'subgraph.name':")
      expect(surroundingFailure).toContain("'exception.message':")
    })

    it('should have both success and failure paths for sdl_validated', () => {
      const src = readSource('server.ts')
      const eventOccurrences = src.split("'event.name': 'gateway.subgraph.sdl_validated'")
      // Should appear at least twice — once for success, once for failure
      expect(eventOccurrences.length).toBeGreaterThanOrEqual(3) // split produces n+1 parts for n occurrences
    })
  })
})
