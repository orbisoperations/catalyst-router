import { describe, it, expect, beforeAll } from 'bun:test'
import { decodeToken } from '../src/jwt.js'
import { Permission } from '../src/permissions.js'
import type { JWTPayload } from 'jose'

describe('System Admin Token', () => {
  let systemToken: string

  beforeAll(async () => {
    // Ensure we don't try to write to disk in this environment
    process.env.KEY_MANAGER_TYPE = 'ephemeral'

    // Import and start server to trigger minting
    const { startServer } = await import('../src/server.js')
    const result = await startServer()
    systemToken = result.systemToken!
  })

  it('should be minted and available after startup', () => {
    expect(systemToken).toBeDefined()
    expect(typeof systemToken).toBe('string')
    expect(systemToken.length).toBeGreaterThan(10)
  })

  it('should contain expected administrative claims', () => {
    const result = decodeToken(systemToken)
    expect(result).toBeDefined()
    const payload = result?.payload as JWTPayload
    expect(payload).toBeDefined()

    expect(payload.sub).toBe('system-admin')
    expect(payload.role).toBe('admin')
    expect(Array.isArray(payload.permissions)).toBe(true)

    const permissions = payload.permissions

    // Comprehensive list of expected discrete permissions
    const expectedPermissions = [
      Permission.TokenCreate,
      Permission.TokenRevoke,
      Permission.TokenList,
      Permission.PeerCreate,
      Permission.PeerUpdate,
      Permission.PeerDelete,
      Permission.RouteCreate,
      Permission.RouteDelete,
      Permission.IbgpConnect,
      Permission.IbgpDisconnect,
      Permission.IbgpUpdate,
    ]

    for (const perm of expectedPermissions) {
      expect(permissions).toContain(perm)
    }

    expect(permissions).toHaveLength(expectedPermissions.length)
  })
})
