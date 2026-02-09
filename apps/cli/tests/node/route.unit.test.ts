import { describe, expect, it } from 'bun:test'
import { routeCommands } from '../../src/commands/node/route.js'

describe('Route Commands', () => {
  describe('Command Structure', () => {
    it('should create route command group', () => {
      const route = routeCommands()
      expect(route.name()).toBe('route')
      expect(route.description()).toContain('Manage local routes')
    })

    it('should have create subcommand', () => {
      const route = routeCommands()
      const create = route.commands.find((cmd) => cmd.name() === 'create')
      expect(create).toBeDefined()
      expect(create?.description()).toContain('Create a new local route')
    })

    it('should have list subcommand', () => {
      const route = routeCommands()
      const list = route.commands.find((cmd) => cmd.name() === 'list')
      expect(list).toBeDefined()
      expect(list?.description()).toContain('List all routes')
    })

    it('should have delete subcommand', () => {
      const route = routeCommands()
      const del = route.commands.find((cmd) => cmd.name() === 'delete')
      expect(del).toBeDefined()
      expect(del?.description()).toContain('Delete a local route')
    })
  })

  describe('create command', () => {
    it('should have required name and endpoint arguments', () => {
      const route = routeCommands()
      const create = route.commands.find((cmd) => cmd.name() === 'create')
      expect(create?.registeredArguments.length).toBe(2)
      expect(create?.registeredArguments[0].name()).toBe('name')
      expect(create?.registeredArguments[1].name()).toBe('endpoint')
    })

    it('should have protocol, region, tags, and token options', () => {
      const route = routeCommands()
      const create = route.commands.find((cmd) => cmd.name() === 'create')
      const optionNames = create?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--protocol')
      expect(optionNames).toContain('--region')
      expect(optionNames).toContain('--tags')
      expect(optionNames).toContain('--token')
    })

    it('should have default protocol of http:graphql', () => {
      const route = routeCommands()
      const create = route.commands.find((cmd) => cmd.name() === 'create')
      const protocolOption = create?.options.find((opt) => opt.long === '--protocol')
      expect(protocolOption?.defaultValue).toBe('http:graphql')
    })
  })

  describe('list command', () => {
    it('should have optional token option', () => {
      const route = routeCommands()
      const list = route.commands.find((cmd) => cmd.name() === 'list')
      const optionNames = list?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--token')
    })
  })

  describe('delete command', () => {
    it('should have required name argument', () => {
      const route = routeCommands()
      const del = route.commands.find((cmd) => cmd.name() === 'delete')
      expect(del?.registeredArguments.length).toBe(1)
      expect(del?.registeredArguments[0].name()).toBe('name')
    })

    it('should have optional token option', () => {
      const route = routeCommands()
      const del = route.commands.find((cmd) => cmd.name() === 'delete')
      const optionNames = del?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--token')
    })
  })
})
