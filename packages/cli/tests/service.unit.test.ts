import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { addService, listServices } from '../src/commands/service.js'
import { AddServiceInputSchema } from '../src/types.js'

// Mock the client creation
const mockApplyAction = mock((_action: unknown) =>
  Promise.resolve({ success: true, error: undefined as string | undefined })
)
const mockListLocalRoutes = mock(() =>
  Promise.resolve({ routes: { local: [] as any[], internal: [] as any[] } })
)

const mockCreateClient = mock(() =>
  Promise.resolve({
    connectionFromManagementSDK: () =>
      ({
        applyAction: mockApplyAction,
        listLocalRoutes: mockListLocalRoutes,
        listMetrics: mock(() => Promise.resolve({ metrics: [] })),
        listPeers: mock(() => Promise.resolve({ peers: [] })),
        deletePeer: mock(() => Promise.resolve({ success: true })),
      }) as unknown,
    [Symbol.asyncDispose]: async () => {},
  } as unknown)
)

mock.module('../src/client.js', () => {
  return {
    createClient: mockCreateClient,
  }
})

describe('Service Commands', () => {
  beforeEach(() => {
    mockApplyAction.mockClear()
    mockListLocalRoutes.mockClear()
    mockCreateClient.mockClear()
    // Reset default implementation if needed, but here we rely on default returning the object
    // and override using mockResolvedValue logic only when needed, but primarily we want the default behavior.
    // If a test changed implementation, we must reset it.
    mockCreateClient.mockImplementation(() =>
      Promise.resolve({
        connectionFromManagementSDK: () =>
          ({
            applyAction: mockApplyAction,
            listLocalRoutes: mockListLocalRoutes,
            listMetrics: mock(() => Promise.resolve({ metrics: [] })),
            listPeers: mock(() => Promise.resolve({ peers: [] })),
            deletePeer: mock(() => Promise.resolve({ success: true })),
          }) as unknown,
        [Symbol.asyncDispose]: async () => {},
      } as unknown)
    )
  })

  describe('addService', () => {
    it('should add a service successfully', async () => {
      const result = await addService({
        name: 'test-service',
        endpoint: 'http://localhost:8080',
        protocol: 'http:graphql',
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      })
      expect(result.success).toBe(true)
      expect(mockApplyAction).toHaveBeenCalled()
      const lastCall = mockApplyAction.mock.calls[0][0]
      expect(lastCall).toEqual({
        resource: 'localRoute',
        resourceAction: 'create',
        data: {
          name: 'test-service',
          endpoint: 'http://localhost:8080',
          protocol: 'http:graphql',
        },
      })
    })

    it('should handle failure when adding service', async () => {
      mockApplyAction.mockImplementationOnce(() =>
        Promise.resolve({ success: false, error: 'Failed' })
      )
      const result = await addService({
        name: 'fail',
        endpoint: 'err', // Invalid URL but valid string type. Logic validation? Zod type enforces URL!
        // Wait. 'err' is NOT a valid URL.
        // If addService takes AddServiceInput, expecting VALID data.
        // But in unit test I am bypassing Zod parser.
        // So I pass manual object.
        // If I pass 'err', and AddServiceInput.endpoint is `string`. It IS string.
        // Zod "brand" types? No, just string.
        // So TS allows 'err'.
        protocol: 'http:graphql',
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        // logic check
        expect(result.error).toBe('Failed')
      }
    })

    it('should handle connection errors', async () => {
      mockCreateClient.mockRejectedValueOnce(new Error('Connect Error'))
      const result = await addService({
        name: 'fail',
        endpoint: 'http://valid-url-for-this-test', // updated to avoid confusion, though logic is mocked
        protocol: 'http:graphql',
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Connect Error')
      }
    })
  })

  describe('listServices', () => {
    it('should list services', async () => {
      mockListLocalRoutes.mockResolvedValueOnce({
        routes: { local: [{ name: 's1', endpoint: 'url' }], internal: [] },
      })
      const result = await listServices()
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(1)
        expect((result.data as { name: string }[])[0].name).toBe('s1')
      }
    })
  })
})

describe('Validation Schema', () => {
  // Schema now imported at top level

  it('should validate correct input', () => {
    const input = { name: 'valid', endpoint: 'http://valid.com', protocol: 'http:graphql' }
    const result = AddServiceInputSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('should fail on invalid url', () => {
    const input = { name: 'valid', endpoint: 'not-a-url', protocol: 'http:graphql' }
    const result = AddServiceInputSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Invalid URL')
    }
  })

  it('should fail on invalid protocol', () => {
    const input = { name: 'valid', endpoint: 'http://valid.com', protocol: 'invalid-proto' }
    const result = AddServiceInputSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})
