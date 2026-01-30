import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'

import type { IKeyManager } from '../key-manager/types.js'
import { type RevocationStore } from '../revocation.js'
import type { BootstrapService } from '../bootstrap.js'
import type { LoginService } from '../login.js'
import type { ApiKeyService } from '../api-key-service.js'
import type { CatalystResource, Permission, PermissionService, Role } from '../permissions.js'
import {
  CreateFirstAdminRequestSchema,
  LoginRequestSchema,
  type CreateFirstAdminResponse,
  type GetBootstrapStatusResponse,
  type LoginResponse,
  type AdminHandlers,
  type ValidationHandlers,
} from './schema.js'
import type { Value } from '@cerbos/core'

export class AuthRpcServer extends RpcTarget {
  private systemToken?: string

  setSystemToken(token: string) {
    this.systemToken = token
  }

  getSystemToken(): string | undefined {
    return this.systemToken
  }

  constructor(
    private keyManager: IKeyManager,
    private revocationStore?: RevocationStore,
    private bootstrapService?: BootstrapService,
    private loginService?: LoginService,
    private apiKeyService?: ApiKeyService,
    private permissionService?: PermissionService
  ) {
    super()
  }

  // --- Public API ---

  async login(request: unknown): Promise<LoginResponse> {
    if (!this.loginService) {
      return { success: false, error: 'Login not configured' }
    }
    const parsed = LoginRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }
    const result = await this.loginService.login(parsed.data)
    if (!result.success) {
      return { success: false, error: result.error ?? 'Login failed' }
    }
    return {
      success: true,
      token: result.token!,
      expiresAt: result.expiresAt!.toISOString(),
    }
  }

  async createFirstAdmin(request: unknown): Promise<CreateFirstAdminResponse> {
    if (!this.bootstrapService) {
      return { success: false, error: 'Bootstrap not configured' }
    }
    const parsed = CreateFirstAdminRequestSchema.safeParse(request)
    if (!parsed.success) {
      return { success: false, error: 'Invalid request' }
    }
    const result = await this.bootstrapService.createFirstAdmin(parsed.data)
    if (!result.success) {
      return { success: false, error: result.error ?? 'Bootstrap failed' }
    }

    const token = await this.keyManager.sign({
      subject: result.userId!,
      expiresIn: '1h',
      claims: {
        roles: ['admin'],
        orgId: 'default',
      },
    })

    return {
      success: true,
      userId: result.userId!,
      token,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }
  }

  async getBootstrapStatus(): Promise<GetBootstrapStatusResponse> {
    if (!this.bootstrapService) {
      return { initialized: false, used: false }
    }
    return this.bootstrapService.getBootstrapStatus()
  }

  // --- Progressive API Entry Points ---

  async admin(token: string): Promise<AdminHandlers | { error: string }> {
    const auth = await this.keyManager.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    const roles = (auth.payload.roles as string[]) || []
    if (!roles.includes('admin')) {
      return { error: 'Permission denied: admin role required' }
    }

    return {
      createToken: async (req: { role: Role; name: string }) => {
        // In a real impl, this would probably create a service account or sign a long-lived token
        return this.keyManager.sign({
          subject: req.name,
          claims: { roles: [req.role] },
        })
      },
      revokeToken: async (req: { target: string }) => {
        if (!this.revocationStore) throw new Error('Revocation not enabled')
        // Target can be a token (decode JTI) or a JTI directly
        this.revocationStore.revoke(req.target, new Date(Date.now() + 86400000))
      },
    }
  }

  async validation(token: string): Promise<ValidationHandlers | { error: string }> {
    const auth = await this.keyManager.verify(token)
    if (!auth.valid) {
      return { error: 'Invalid token' }
    }

    // Role check could be added here if validation requires specific roles

    return {
      getJWKS: async () => {
        const jwks = await this.keyManager.getJwks()
        return { success: true, jwks: { keys: jwks.keys as Record<string, unknown>[] } }
      },
      getRevocationList: async () => {
        // Return list of revoked JTIs if supported by store
        return []
      },
      validate: async (req: { token: string }) => {
        const result = await this.keyManager.verify(req.token)
        if (!result.valid) return { valid: false, error: 'Invalid token' }

        if (this.revocationStore && result.payload.jti) {
          if (this.revocationStore.isRevoked(result.payload.jti as string)) {
            return { valid: false, error: 'Token revoked' }
          }
        }

        return { valid: true, payload: result.payload }
      },
      isAuthorized: async (req: {
        token: string
        resource: CatalystResource
        action: Permission
      }): Promise<boolean> => {
        if (!this.permissionService) {
          return false
        }
        const auth = await this.keyManager.verify(req.token)
        if (!auth.valid) {
          return false
        }
        return this.permissionService.isAuthorized(
          {
            id: auth.payload.sub as string,
            roles: auth.payload.roles as Role[],
            attr: auth.payload.attr as Record<string, Value>,
          },
          req.resource,
          req.action
        )
      },
    }
  }
}

export function createAuthRpcHandler(rpcServer: AuthRpcServer): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, {
      upgradeWebSocket,
    })
  })

  // Note: For progressive API, HTTP POST JSON-RPC is trickier as it involves
  // nested handler sets. capnweb handles this via references over WebSocket.
  // For now, we prioritize the WebSocket/capnweb interface for progressive usage.

  return app
}
