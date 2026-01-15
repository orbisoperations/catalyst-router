import { BasePlugin } from '../base.js'
import type { PluginContext, PluginResult } from '../types.js'
import { hasPermission } from '../../auth/permissions.js'

/**
 * Auth plugin that enforces RBAC permissions.
 *
 * Token verification is done at connection time (session creation).
 * This plugin checks that the authenticated user has permission
 * to perform the requested action.
 */
export class AuthPlugin extends BasePlugin {
  name = 'AuthPlugin'

  async apply(context: PluginContext): Promise<PluginResult> {
    const { action, authxContext } = context
    const { resource, action: resourceAction } = action
    const roles = authxContext.roles
    const userId = authxContext.userId ?? 'anonymous'

    // Check RBAC permissions
    const allowed = hasPermission(roles, resource, resourceAction)

    if (!allowed) {
      console.warn(
        `[AuthPlugin] Denied: user=${userId} roles=[${roles?.join(',') ?? ''}] ` +
          `action=${resource}:${resourceAction}`
      )

      return {
        success: false,
        error: {
          pluginName: this.name,
          message: `Permission denied: ${resource}:${resourceAction} requires elevated privileges`,
        },
      }
    }

    console.log(
      `[AuthPlugin] Allowed: user=${userId} roles=[${roles?.join(',') ?? ''}] ` +
        `action=${resource}:${resourceAction}`
    )

    return { success: true, ctx: context }
  }
}
