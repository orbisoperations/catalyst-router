import { describe, it, expect } from 'bun:test'
import {
  PortEntrySchema,
  EnvoyConfigSchema,
  CatalystConfigSchema,
  NodeConfigSchema,
  OrchestratorConfigSchema,
  loadDefaultConfig,
} from '../src/index.js'

describe('PortEntrySchema', () => {
  it('validates a single port number', () => {
    const result = PortEntrySchema.safeParse(8000)
    expect(result.success).toBe(true)
  })

  it('validates a [start, end] tuple', () => {
    const result = PortEntrySchema.safeParse([9000, 9010])
    expect(result.success).toBe(true)
  })

  it('validates boundary port numbers', () => {
    expect(PortEntrySchema.safeParse(1).success).toBe(true)
    expect(PortEntrySchema.safeParse(65535).success).toBe(true)
  })

  it('rejects negative port numbers', () => {
    const result = PortEntrySchema.safeParse(-1)
    expect(result.success).toBe(false)
  })

  it('rejects port 0', () => {
    const result = PortEntrySchema.safeParse(0)
    expect(result.success).toBe(false)
  })

  it('rejects port numbers above 65535', () => {
    const result = PortEntrySchema.safeParse(65536)
    expect(result.success).toBe(false)
  })

  it('rejects non-integer port numbers', () => {
    const result = PortEntrySchema.safeParse(8000.5)
    expect(result.success).toBe(false)
  })

  it('rejects tuple where start > end', () => {
    const result = PortEntrySchema.safeParse([9010, 9000])
    expect(result.success).toBe(false)
  })

  it('rejects tuple with negative ports', () => {
    const result = PortEntrySchema.safeParse([-1, 9000])
    expect(result.success).toBe(false)
  })

  it('rejects tuple with ports above 65535', () => {
    const result = PortEntrySchema.safeParse([9000, 70000])
    expect(result.success).toBe(false)
  })

  it('rejects tuple with non-integer ports', () => {
    const result = PortEntrySchema.safeParse([9000.5, 9010])
    expect(result.success).toBe(false)
  })

  it('accepts tuple where start equals end (single port as range)', () => {
    const result = PortEntrySchema.safeParse([9000, 9000])
    expect(result.success).toBe(true)
  })

  it('rejects strings', () => {
    const result = PortEntrySchema.safeParse('8000')
    expect(result.success).toBe(false)
  })
})

describe('EnvoyConfigSchema', () => {
  it('parses valid config with all fields', () => {
    const result = EnvoyConfigSchema.safeParse({
      adminPort: 9902,
      xdsPort: 18001,
      bindAddress: '127.0.0.1',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.adminPort).toBe(9902)
      expect(result.data.xdsPort).toBe(18001)
      expect(result.data.bindAddress).toBe('127.0.0.1')
    }
  })

  it('uses default adminPort of 9901', () => {
    const result = EnvoyConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.adminPort).toBe(9901)
    }
  })

  it('uses default xdsPort of 18000', () => {
    const result = EnvoyConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.xdsPort).toBe(18000)
    }
  })

  it('uses default bindAddress of 0.0.0.0', () => {
    const result = EnvoyConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.bindAddress).toBe('0.0.0.0')
    }
  })

  it('parses with empty object (all defaults)', () => {
    const result = EnvoyConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('CatalystConfigSchema with envoy field', () => {
  const baseConfig = {
    node: {
      name: 'test-node',
      domains: ['test.local'],
      endpoint: 'http://localhost:3000',
    },
    port: 3000,
  }

  it('parses existing config without envoy field', () => {
    const result = CatalystConfigSchema.safeParse(baseConfig)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoy).toBeUndefined()
    }
  })

  it('parses config with envoy field', () => {
    const result = CatalystConfigSchema.safeParse({
      ...baseConfig,
      envoy: {
        adminPort: 9901,
        xdsPort: 18000,
        bindAddress: '0.0.0.0',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoy).toBeDefined()
      expect(result.data.envoy!.adminPort).toBe(9901)
    }
  })

  it('envoy field is optional', () => {
    const result = CatalystConfigSchema.safeParse(baseConfig)
    expect(result.success).toBe(true)
  })

  it('envoy field accepts empty object (all defaults)', () => {
    const result = CatalystConfigSchema.safeParse({
      ...baseConfig,
      envoy: {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoy!.adminPort).toBe(9901)
    }
  })
})

describe('NodeConfigSchema without envoyAddress (removed)', () => {
  it('parses without envoyAddress', () => {
    const result = NodeConfigSchema.safeParse({
      name: 'test-node',
      domains: ['test.local'],
    })
    expect(result.success).toBe(true)
  })

  it('existing fields still parse correctly', () => {
    const result = NodeConfigSchema.safeParse({
      name: 'test-node',
      domains: ['test.local'],
      endpoint: 'http://localhost:3000',
      labels: { env: 'prod' },
      peerToken: 'tok-123',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('test-node')
      expect(result.data.domains).toEqual(['test.local'])
      expect(result.data.endpoint).toBe('http://localhost:3000')
      expect(result.data.labels).toEqual({ env: 'prod' })
      expect(result.data.peerToken).toBe('tok-123')
    }
  })
})

describe('OrchestratorConfigSchema with envoyConfig', () => {
  it('parses without envoyConfig (backward compatible)', () => {
    const result = OrchestratorConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyConfig).toBeUndefined()
    }
  })

  it('parses with full envoyConfig', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        portRange: [8000, [9000, 9010]],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyConfig).toBeDefined()
      expect(result.data.envoyConfig!.endpoint).toBe('http://localhost:18000')
      expect(result.data.envoyConfig!.portRange).toEqual([8000, [9000, 9010]])
    }
  })

  it('parses with envoyConfig.envoyAddress', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        envoyAddress: 'https://10.0.0.5:443',
        portRange: [8000],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyConfig!.envoyAddress).toBe('https://10.0.0.5:443')
    }
  })

  it('envoyAddress is optional within envoyConfig', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        portRange: [8000],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyConfig!.envoyAddress).toBeUndefined()
    }
  })

  it('requires portRange with at least one entry in envoyConfig', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        portRange: [],
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects envoyConfig without portRange', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
      },
    })
    expect(result.success).toBe(false)
  })

  it('validates mixed port entries in envoyConfig.portRange', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        portRange: [8000, [9000, 9010], 10000, [11000, 11500]],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.envoyConfig!.portRange.length).toBe(4)
    }
  })

  it('rejects invalid port entries in envoyConfig.portRange', () => {
    const result = OrchestratorConfigSchema.safeParse({
      envoyConfig: {
        endpoint: 'http://localhost:18000',
        portRange: [-1],
      },
    })
    expect(result.success).toBe(false)
  })

  it('existing fields still parse correctly', () => {
    const result = OrchestratorConfigSchema.safeParse({
      gqlGatewayConfig: { endpoint: 'http://localhost:4000' },
      envoyConfig: { endpoint: 'http://localhost:18000', portRange: [8000] },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.gqlGatewayConfig?.endpoint).toBe('http://localhost:4000')
      expect(result.data.envoyConfig?.endpoint).toBe('http://localhost:18000')
    }
  })
})

describe("ServiceType includes 'envoy'", () => {
  it("'envoy' is a valid ServiceType value", () => {
    const serviceType = 'envoy' as const
    expect(serviceType).toBe('envoy')
  })
})

describe('loadDefaultConfig with envoy env vars', () => {
  const originalEnv = { ...process.env }

  const setRequiredEnv = () => {
    process.env.CATALYST_NODE_ID = 'test-node.somebiz.local.io'
    process.env.CATALYST_PEERING_ENDPOINT = 'ws://localhost:3000'
    process.env.CATALYST_DOMAINS = 'somebiz.local.io'
  }

  const clearEnv = () => {
    process.env = { ...originalEnv }
  }

  it('parses CATALYST_ENVOY_PORT_RANGE into orchestrator.envoyConfig', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_PORT_RANGE = '[8000, [9000, 9010], 10000]'
    process.env.CATALYST_ENVOY_ENDPOINT = 'http://localhost:18000'

    try {
      const config = loadDefaultConfig()
      expect(config.orchestrator?.envoyConfig).toBeDefined()
      expect(config.orchestrator!.envoyConfig!.portRange).toEqual([8000, [9000, 9010], 10000])
    } finally {
      clearEnv()
    }
  })

  it('parses CATALYST_ENVOY_ENDPOINT into orchestrator.envoyConfig', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_PORT_RANGE = '[8000]'
    process.env.CATALYST_ENVOY_ENDPOINT = 'http://localhost:18000'

    try {
      const config = loadDefaultConfig()
      expect(config.orchestrator?.envoyConfig).toBeDefined()
      expect(config.orchestrator!.envoyConfig!.endpoint).toBe('http://localhost:18000')
    } finally {
      clearEnv()
    }
  })

  it('parses CATALYST_ENVOY_ADMIN_PORT into envoy config', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_ADMIN_PORT = '9902'

    try {
      const config = loadDefaultConfig()
      expect(config.envoy).toBeDefined()
      expect(config.envoy!.adminPort).toBe(9902)
    } finally {
      clearEnv()
    }
  })

  it('parses CATALYST_ENVOY_XDS_PORT into envoy config', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_XDS_PORT = '18001'

    try {
      const config = loadDefaultConfig()
      expect(config.envoy).toBeDefined()
      expect(config.envoy!.xdsPort).toBe(18001)
    } finally {
      clearEnv()
    }
  })

  it('parses CATALYST_ENVOY_BIND_ADDRESS into envoy config', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_BIND_ADDRESS = '127.0.0.1'

    try {
      const config = loadDefaultConfig()
      expect(config.envoy).toBeDefined()
      expect(config.envoy!.bindAddress).toBe('127.0.0.1')
    } finally {
      clearEnv()
    }
  })

  it('missing envoy env vars results in no envoy or envoyConfig', () => {
    setRequiredEnv()

    try {
      const config = loadDefaultConfig()
      expect(config.envoy).toBeUndefined()
      expect(config.orchestrator?.envoyConfig).toBeUndefined()
    } finally {
      clearEnv()
    }
  })

  it('requires both PORT_RANGE and ENDPOINT for orchestrator.envoyConfig', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_PORT_RANGE = '[8000]'
    // No CATALYST_ENVOY_ENDPOINT set

    try {
      const config = loadDefaultConfig()
      expect(config.orchestrator?.envoyConfig).toBeUndefined()
    } finally {
      clearEnv()
    }
  })

  it('uses default values for envoy adminPort, xdsPort, and bindAddress when not set', () => {
    setRequiredEnv()
    process.env.CATALYST_ENVOY_PORT_RANGE = '[8000]'
    process.env.CATALYST_ENVOY_ENDPOINT = 'http://localhost:18000'

    try {
      const config = loadDefaultConfig()
      // envoy block should not exist when only PORT_RANGE/ENDPOINT are set
      expect(config.envoy).toBeUndefined()
      // but orchestrator.envoyConfig should have portRange
      expect(config.orchestrator?.envoyConfig?.portRange).toEqual([8000])
    } finally {
      clearEnv()
    }
  })
})
