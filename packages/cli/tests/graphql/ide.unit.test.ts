import { describe, expect, it } from 'bun:test'
import { graphqlCommands } from '../../src/commands/graphql/index.js'

describe('GraphQL Commands', () => {
  describe('Command Structure', () => {
    it('should create graphql command group', () => {
      const graphql = graphqlCommands()
      expect(graphql.name()).toBe('graphql')
      expect(graphql.description()).toContain('GraphQL development tools')
    })

    it('should have ide subcommand', () => {
      const graphql = graphqlCommands()
      const ide = graphql.commands.find((cmd) => cmd.name() === 'ide')
      expect(ide).toBeDefined()
      expect(ide?.description()).toContain('GraphiQL IDE')
    })
  })

  describe('ide command', () => {
    it('should have port option with default', () => {
      const graphql = graphqlCommands()
      const ide = graphql.commands.find((cmd) => cmd.name() === 'ide')
      const portOpt = ide?.options.find((opt) => opt.long === '--port')
      expect(portOpt).toBeDefined()
      expect(portOpt?.defaultValue).toBe('5173')
    })

    it('should have endpoint option with default', () => {
      const graphql = graphqlCommands()
      const ide = graphql.commands.find((cmd) => cmd.name() === 'ide')
      const endpointOpt = ide?.options.find((opt) => opt.long === '--endpoint')
      expect(endpointOpt).toBeDefined()
      expect(endpointOpt?.defaultValue).toBe('http://localhost:4000/graphql')
    })

    it('should have no-open option', () => {
      const graphql = graphqlCommands()
      const ide = graphql.commands.find((cmd) => cmd.name() === 'ide')
      const openOpt = ide?.options.find((opt) => opt.long === '--no-open')
      expect(openOpt).toBeDefined()
    })
  })
})
