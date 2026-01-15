import { describe, it, expect } from 'bun:test'
import { AuthPlugin } from '../src/plugins/implementations/auth.js'
import { RouteTable } from '../src/state/route-table.js'
import type { PluginContext } from '../src/plugins/types.js'

/**
 * Tests for AuthPlugin RBAC permission checking.
 *
 * Architecture note: Token verification is done at connection time (session creation).
 * AuthPlugin only checks if the authenticated user has permission to perform
 * the requested action based on their roles.
 *
 * See: docs/AUTH_DESIGN_OPTIONS.md (Option 3: Session-based auth)
 */
describe('AuthPlugin RBAC', () => {
  const plugin = new AuthPlugin()

  function createContext(
    roles: string[] | undefined,
    resource: string,
    action: string,
    userId = 'test-user'
  ): PluginContext {
    return {
      action: { resource, action } as any,
      state: new RouteTable(),
      authxContext: { userId, roles },
    }
  }

  describe('admin role', () => {
    it('should allow dataChannel:create', async () => {
      const result = await plugin.apply(createContext(['admin'], 'dataChannel', 'create'))
      expect(result.success).toBe(true)
    })

    it('should allow dataChannel:delete', async () => {
      const result = await plugin.apply(createContext(['admin'], 'dataChannel', 'delete'))
      expect(result.success).toBe(true)
    })

    it('should allow arbitrary resource:action (wildcard)', async () => {
      const result = await plugin.apply(createContext(['admin'], 'anyResource', 'anyAction'))
      expect(result.success).toBe(true)
    })
  })

  describe('operator role', () => {
    it('should allow dataChannel:create', async () => {
      const result = await plugin.apply(createContext(['operator'], 'dataChannel', 'create'))
      expect(result.success).toBe(true)
    })

    it('should allow dataChannel:update', async () => {
      const result = await plugin.apply(createContext(['operator'], 'dataChannel', 'update'))
      expect(result.success).toBe(true)
    })

    it('should allow dataChannel:delete', async () => {
      const result = await plugin.apply(createContext(['operator'], 'dataChannel', 'delete'))
      expect(result.success).toBe(true)
    })

    it('should deny actions outside its permissions', async () => {
      const result = await plugin.apply(createContext(['operator'], 'system', 'shutdown'))
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.message).toContain('Permission denied')
      }
    })

    it('should deny dataChannel:read (not in operator permissions)', async () => {
      const result = await plugin.apply(createContext(['operator'], 'dataChannel', 'read'))
      expect(result.success).toBe(false)
    })
  })

  describe('viewer role', () => {
    it('should deny dataChannel:create', async () => {
      const result = await plugin.apply(createContext(['viewer'], 'dataChannel', 'create'))
      expect(result.success).toBe(false)
    })

    it('should deny dataChannel:delete', async () => {
      const result = await plugin.apply(createContext(['viewer'], 'dataChannel', 'delete'))
      expect(result.success).toBe(false)
    })

    it('should deny all actions (viewer has empty permissions)', async () => {
      const result = await plugin.apply(createContext(['viewer'], 'anything', 'anything'))
      expect(result.success).toBe(false)
    })
  })

  describe('no roles', () => {
    it('should deny with empty roles array', async () => {
      const result = await plugin.apply(createContext([], 'dataChannel', 'create'))
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.message).toContain('Permission denied')
      }
    })

    it('should deny with undefined roles', async () => {
      const result = await plugin.apply(createContext(undefined, 'dataChannel', 'create'))
      expect(result.success).toBe(false)
    })
  })

  describe('multiple roles', () => {
    it('should allow if any role has permission (viewer + operator)', async () => {
      const result = await plugin.apply(
        createContext(['viewer', 'operator'], 'dataChannel', 'create')
      )
      expect(result.success).toBe(true)
    })

    it('should allow if any role has permission (viewer + admin)', async () => {
      const result = await plugin.apply(createContext(['viewer', 'admin'], 'system', 'shutdown'))
      expect(result.success).toBe(true)
    })

    it('should deny if no role has permission', async () => {
      const result = await plugin.apply(createContext(['viewer', 'operator'], 'system', 'shutdown'))
      expect(result.success).toBe(false)
    })
  })

  describe('unknown roles', () => {
    it('should deny unknown role', async () => {
      const result = await plugin.apply(createContext(['superuser'], 'dataChannel', 'create'))
      expect(result.success).toBe(false)
    })

    it('should deny mix of unknown roles', async () => {
      const result = await plugin.apply(
        createContext(['root', 'superuser', 'god'], 'dataChannel', 'create')
      )
      expect(result.success).toBe(false)
    })
  })

  describe('error messages', () => {
    it('should include resource:action in error message', async () => {
      const result = await plugin.apply(createContext(['viewer'], 'dataChannel', 'create'))
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.message).toContain('dataChannel:create')
      }
    })

    it('should identify AuthPlugin as error source', async () => {
      const result = await plugin.apply(createContext(['viewer'], 'dataChannel', 'create'))
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.pluginName).toBe('AuthPlugin')
      }
    })
  })
})
