import type { AuthServiceApi } from '../src/orchestrator.js'

/**
 * Creates a mock auth provider that approves all operations.
 * Use for unit tests that need a CatalystNodeBus but don't test auth logic.
 */
export function createMockAuthProvider(): AuthServiceApi {
  return {
    authenticate: async () => ({ valid: true as const, payload: { sub: 'test' } }),
    permissions: async () => ({
      authorizeAction: async () => ({ success: true as const, allowed: true }),
    }),
  }
}
