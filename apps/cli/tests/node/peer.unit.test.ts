import { describe, expect, it } from 'bun:test'
import { peerCommands } from '../../src/commands/node/peer.js'

describe('Peer Commands', () => {
  describe('Command Structure', () => {
    it('should create peer command group', () => {
      const peer = peerCommands()
      expect(peer.name()).toBe('peer')
      expect(peer.description()).toContain('Manage peer connections')
    })

    it('should have create subcommand', () => {
      const peer = peerCommands()
      const create = peer.commands.find((cmd) => cmd.name() === 'create')
      expect(create).toBeDefined()
      expect(create?.description()).toContain('Create a new peer connection')
    })

    it('should have list subcommand', () => {
      const peer = peerCommands()
      const list = peer.commands.find((cmd) => cmd.name() === 'list')
      expect(list).toBeDefined()
      expect(list?.description()).toContain('List all peers')
    })

    it('should have delete subcommand', () => {
      const peer = peerCommands()
      const del = peer.commands.find((cmd) => cmd.name() === 'delete')
      expect(del).toBeDefined()
      expect(del?.description()).toContain('Delete a peer connection')
    })
  })

  describe('create command', () => {
    it('should have required name and endpoint arguments', () => {
      const peer = peerCommands()
      const create = peer.commands.find((cmd) => cmd.name() === 'create')
      expect(create?.registeredArguments.length).toBe(2)
      expect(create?.registeredArguments[0].name()).toBe('name')
      expect(create?.registeredArguments[1].name()).toBe('endpoint')
    })

    it('should have optional domains, peer-token, and token options', () => {
      const peer = peerCommands()
      const create = peer.commands.find((cmd) => cmd.name() === 'create')
      const optionNames = create?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--domains')
      expect(optionNames).toContain('--peer-token')
      expect(optionNames).toContain('--token')
    })
  })

  describe('list command', () => {
    it('should have optional token option', () => {
      const peer = peerCommands()
      const list = peer.commands.find((cmd) => cmd.name() === 'list')
      const optionNames = list?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--token')
    })
  })

  describe('delete command', () => {
    it('should have required name argument', () => {
      const peer = peerCommands()
      const del = peer.commands.find((cmd) => cmd.name() === 'delete')
      expect(del?.registeredArguments.length).toBe(1)
      expect(del?.registeredArguments[0].name()).toBe('name')
    })

    it('should have optional token option', () => {
      const peer = peerCommands()
      const del = peer.commands.find((cmd) => cmd.name() === 'delete')
      const optionNames = del?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--token')
    })
  })
})
