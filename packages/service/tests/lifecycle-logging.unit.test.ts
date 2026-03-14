import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Static analysis tests: verify that structured lifecycle logging events
 * are present in the service and server source files.
 *
 * These tests scan source code for required event.name strings to ensure
 * lifecycle events are emitted during startup and shutdown sequences.
 */
describe('lifecycle logging', () => {
  const serviceFile = path.resolve(__dirname, '../src/catalyst-service.ts')
  const serverFile = path.resolve(__dirname, '../src/catalyst-hono-server.ts')

  describe('catalyst-service.ts', () => {
    const content = fs.readFileSync(serviceFile, 'utf-8')

    it('service.initialized event includes event.duration_ms', () => {
      expect(content).toContain("'event.name': 'service.initialized'")
      expect(content).toContain("'catalyst.event.duration_ms':")
    })

    it('emits service.shutdown.started event', () => {
      expect(content).toContain("'event.name': 'service.shutdown.started'")
    })

    it('emits service.shutdown.completed event with duration', () => {
      expect(content).toContain("'event.name': 'service.shutdown.completed'")
      // Verify the shutdown.completed block includes duration_ms
      const shutdownCompletedIdx = content.indexOf("'event.name': 'service.shutdown.completed'")
      // Find the enclosing logger call (look backwards for 'logger.')
      const blockStart = content.lastIndexOf('logger.', shutdownCompletedIdx)
      // Find the closing of the log call (next })  after the event.name)
      const blockEnd = content.indexOf('})', shutdownCompletedIdx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'catalyst.event.duration_ms':")
    })
  })

  describe('catalyst-hono-server.ts', () => {
    const content = fs.readFileSync(serverFile, 'utf-8')

    it('emits server.shutdown.started event with service.count', () => {
      expect(content).toContain("'event.name': 'server.shutdown.started'")
      const startedIdx = content.indexOf("'event.name': 'server.shutdown.started'")
      const blockStart = content.lastIndexOf('logger', startedIdx)
      const blockEnd = content.indexOf('})', startedIdx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'catalyst.server.service_count':")
    })

    it('emits server.shutdown.completed event with duration and service.count', () => {
      expect(content).toContain("'event.name': 'server.shutdown.completed'")
      const completedIdx = content.indexOf("'event.name': 'server.shutdown.completed'")
      const blockStart = content.lastIndexOf('logger', completedIdx)
      const blockEnd = content.indexOf('})', completedIdx)
      const block = content.slice(blockStart, blockEnd)
      expect(block).toContain("'catalyst.event.duration_ms':")
      expect(block).toContain("'catalyst.server.service_count':")
    })
  })
})
