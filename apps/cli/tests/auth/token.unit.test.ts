import { describe, expect, it } from 'bun:test'
import { tokenCommands } from '../../src/commands/auth/token.js'

describe('Token Commands', () => {
  describe('Command Structure', () => {
    it('should create token command group', () => {
      const token = tokenCommands()
      expect(token.name()).toBe('token')
      expect(token.description()).toContain('Token management')
    })

    it('should have mint subcommand', () => {
      const token = tokenCommands()
      const mint = token.commands.find((cmd) => cmd.name() === 'mint')
      expect(mint).toBeDefined()
      expect(mint?.description()).toContain('Mint a new token')
    })

    it('should have verify subcommand', () => {
      const token = tokenCommands()
      const verify = token.commands.find((cmd) => cmd.name() === 'verify')
      expect(verify).toBeDefined()
      expect(verify?.description()).toContain('Verify a token')
    })

    it('should have revoke subcommand', () => {
      const token = tokenCommands()
      const revoke = token.commands.find((cmd) => cmd.name() === 'revoke')
      expect(revoke).toBeDefined()
      expect(revoke?.description()).toContain('Revoke a token')
    })

    it('should have list subcommand', () => {
      const token = tokenCommands()
      const list = token.commands.find((cmd) => cmd.name() === 'list')
      expect(list).toBeDefined()
      expect(list?.description()).toContain('List tokens')
    })
  })

  describe('mint command', () => {
    it('should have required subject argument', () => {
      const token = tokenCommands()
      const mint = token.commands.find((cmd) => cmd.name() === 'mint')
      expect(mint?.registeredArguments.length).toBe(1)
      expect(mint?.registeredArguments[0].name()).toBe('subject')
    })

    it('should have principal, name, type, expires-in, node-id, trusted-domains, trusted-nodes, and token options', () => {
      const token = tokenCommands()
      const mint = token.commands.find((cmd) => cmd.name() === 'mint')
      const optionNames = mint?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--principal')
      expect(optionNames).toContain('--name')
      expect(optionNames).toContain('--type')
      expect(optionNames).toContain('--expires-in')
      expect(optionNames).toContain('--node-id')
      expect(optionNames).toContain('--trusted-domains')
      expect(optionNames).toContain('--trusted-nodes')
      expect(optionNames).toContain('--token')
    })

    it('should have default principal of CATALYST::USER', () => {
      const token = tokenCommands()
      const mint = token.commands.find((cmd) => cmd.name() === 'mint')
      const principalOption = mint?.options.find((opt) => opt.long === '--principal')
      expect(principalOption?.defaultValue).toBe('CATALYST::USER')
    })

    it('should have default type of user', () => {
      const token = tokenCommands()
      const mint = token.commands.find((cmd) => cmd.name() === 'mint')
      const typeOption = mint?.options.find((opt) => opt.long === '--type')
      expect(typeOption?.defaultValue).toBe('user')
    })
  })

  describe('verify command', () => {
    it('should have required token-to-verify argument', () => {
      const token = tokenCommands()
      const verify = token.commands.find((cmd) => cmd.name() === 'verify')
      expect(verify?.registeredArguments.length).toBe(1)
      expect(verify?.registeredArguments[0].name()).toBe('token-to-verify')
    })

    it('should have audience and token options', () => {
      const token = tokenCommands()
      const verify = token.commands.find((cmd) => cmd.name() === 'verify')
      const optionNames = verify?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--audience')
      expect(optionNames).toContain('--token')
    })
  })

  describe('revoke command', () => {
    it('should have jti, san, and token options', () => {
      const token = tokenCommands()
      const revoke = token.commands.find((cmd) => cmd.name() === 'revoke')
      const optionNames = revoke?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--jti')
      expect(optionNames).toContain('--san')
      expect(optionNames).toContain('--token')
    })
  })

  describe('list command', () => {
    it('should have cert-fingerprint, san, and token options', () => {
      const token = tokenCommands()
      const list = token.commands.find((cmd) => cmd.name() === 'list')
      const optionNames = list?.options.map((opt) => opt.long)
      expect(optionNames).toContain('--cert-fingerprint')
      expect(optionNames).toContain('--san')
      expect(optionNames).toContain('--token')
    })
  })
})
