import { Command, Option } from 'commander'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ConfigFileSchema, loadConfigFile, applyConfigFileValues } from './config-file.js'

// --- Schema Tests ---

describe('ConfigFileSchema', () => {
  it('validates a complete config', () => {
    const result = ConfigFileSchema.parse({
      nodeId: 'my-node.example.local.io',
      port: 3000,
      hostname: '0.0.0.0',
      peeringEndpoint: 'ws://localhost:3000/orchestrator/rpc',
      domains: ['example.local.io'],
      peeringSecret: 'secret',
      keysDb: './data/keys.db',
      tokensDb: './data/tokens.db',
      revocation: true,
      revocationMaxSize: 5000,
      bootstrapToken: 'tok',
      bootstrapTtl: 3600000,
      gatewayEndpoint: 'ws://localhost:3000/gateway/api',
      logLevel: 'debug',
    })
    expect(result.nodeId).toBe('my-node.example.local.io')
    expect(result.port).toBe(3000)
    expect(result.domains).toEqual(['example.local.io'])
    expect(result.revocation).toBe(true)
  })

  it('accepts partial config (all fields optional)', () => {
    const result = ConfigFileSchema.parse({ nodeId: 'only-this' })
    expect(result.nodeId).toBe('only-this')
    expect(result.port).toBeUndefined()
  })

  it('accepts empty object', () => {
    const result = ConfigFileSchema.parse({})
    expect(Object.keys(result).length).toBe(0)
  })

  it('rejects unknown keys (strict mode)', () => {
    expect(() => ConfigFileSchema.parse({ nodeId: 'ok', typo: 'bad' })).toThrow()
  })

  it('accepts port as number', () => {
    const result = ConfigFileSchema.parse({ port: 4000 })
    expect(result.port).toBe(4000)
  })

  it('accepts port as string', () => {
    const result = ConfigFileSchema.parse({ port: '4000' })
    expect(result.port).toBe('4000')
  })

  it('accepts revocationMaxSize as number', () => {
    const result = ConfigFileSchema.parse({ revocationMaxSize: 1000 })
    expect(result.revocationMaxSize).toBe(1000)
  })

  it('accepts bootstrapTtl as number', () => {
    const result = ConfigFileSchema.parse({ bootstrapTtl: 86400000 })
    expect(result.bootstrapTtl).toBe(86400000)
  })
})

// --- loadConfigFile Tests ---

describe('loadConfigFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function mockBunFile(content: string | null) {
    const mockFile = {
      exists: vi.fn().mockResolvedValue(content !== null),
      text: vi.fn().mockResolvedValue(content ?? ''),
    }
    vi.stubGlobal('Bun', { file: vi.fn().mockReturnValue(mockFile) })
    return mockFile
  }

  it('loads and parses a valid config file', async () => {
    mockBunFile(JSON.stringify({ nodeId: 'test.example.local.io', port: 4000 }))
    const result = await loadConfigFile('/path/to/config.json')
    expect(result.nodeId).toBe('test.example.local.io')
    expect(result.port).toBe('4000') // coerced to string
  })

  it('throws when file does not exist', async () => {
    mockBunFile(null)
    await expect(loadConfigFile('/missing.json')).rejects.toThrow(
      'Config file not found: /missing.json'
    )
  })

  it('throws when file is not valid JSON', async () => {
    mockBunFile('not json {{{')
    await expect(loadConfigFile('/bad.json')).rejects.toThrow(
      'Config file is not valid JSON: /bad.json'
    )
  })

  it('throws when file fails schema validation', async () => {
    mockBunFile(JSON.stringify({ unknownField: true }))
    await expect(loadConfigFile('/invalid.json')).rejects.toThrow()
  })

  it('coerces numeric port to string', async () => {
    mockBunFile(JSON.stringify({ port: 8080 }))
    const result = await loadConfigFile('/config.json')
    expect(result.port).toBe('8080')
  })

  it('converts domains array to comma-separated string', async () => {
    mockBunFile(JSON.stringify({ domains: ['foo.com', 'bar.com'] }))
    const result = await loadConfigFile('/config.json')
    expect(result.domains).toBe('foo.com,bar.com')
  })

  it('preserves boolean revocation value', async () => {
    mockBunFile(JSON.stringify({ revocation: true }))
    const result = await loadConfigFile('/config.json')
    expect(result.revocation).toBe(true)
  })

  it('omits undefined values from result', async () => {
    mockBunFile(JSON.stringify({ nodeId: 'test' }))
    const result = await loadConfigFile('/config.json')
    expect(Object.keys(result)).toEqual(['nodeId'])
  })
})

// --- applyConfigFileValues Tests ---

describe('applyConfigFileValues', () => {
  function makeCommand(): Command {
    const cmd = new Command()
    cmd.addOption(new Option('--node-id <id>').default('default-node'))
    cmd.addOption(new Option('--port <port>').default('3000'))
    return cmd
  }

  it('sets values when current source is default', () => {
    const cmd = makeCommand()
    cmd.parse([], { from: 'user' }) // no CLI args — all defaults

    applyConfigFileValues(cmd, { nodeId: 'from-config', port: '4000' })

    expect(cmd.opts().nodeId).toBe('from-config')
    expect(cmd.getOptionValueSource('nodeId')).toBe('config')
    expect(cmd.opts().port).toBe('4000')
    expect(cmd.getOptionValueSource('port')).toBe('config')
  })

  it('does not override values with cli source', () => {
    const cmd = makeCommand()
    cmd.parse(['--node-id', 'from-cli'], { from: 'user' })

    applyConfigFileValues(cmd, { nodeId: 'from-config' })

    expect(cmd.opts().nodeId).toBe('from-cli')
    expect(cmd.getOptionValueSource('nodeId')).toBe('cli')
  })

  it('handles empty config values object', () => {
    const cmd = makeCommand()
    cmd.parse([], { from: 'user' })

    applyConfigFileValues(cmd, {})

    expect(cmd.opts().nodeId).toBe('default-node')
    expect(cmd.getOptionValueSource('nodeId')).toBe('default')
  })
})
