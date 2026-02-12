import { newWebSocketRpcSession } from 'capnweb'
import { resolveServiceUrl } from './resolve-url.js'

export interface CreateTokenRequest {
  subject: string
  entity: {
    id: string
    name: string
    type: 'user' | 'service'
    nodeId?: string
    trustedNodes?: string[]
    orgDomain?: string
  }
  principal: string
  sans?: string[]
  expiresIn?: string
}

export interface TokenRecord {
  jti: string
  sub: string
  iat: number
  exp: number
  revoked: boolean
  san?: string
  certificateFingerprint?: string
}

export interface ValidateTokenResponse {
  valid: boolean
  payload?: Record<string, unknown>
  error?: string
}

export interface AuthPublicApi {
  tokens(token: string): Promise<AuthTokenHandlers | { error: string }>
  validation(token: string): Promise<AuthValidationHandlers | { error: string }>
}

export interface AuthTokenHandlers {
  create(request: CreateTokenRequest): Promise<string>
  revoke(request: { jti?: string; san?: string }): Promise<void>
  list(request: { certificateFingerprint?: string; san?: string }): Promise<TokenRecord[]>
}

export interface AuthValidationHandlers {
  validate(request: { token: string; audience?: string }): Promise<ValidateTokenResponse>
  getRevocationList(): Promise<string[]>
  getJWKS(): Promise<{ keys: unknown[] }>
}

export async function createAuthClient(url?: string): Promise<AuthPublicApi> {
  const resolved = resolveServiceUrl({ url, envVar: 'CATALYST_AUTH_URL', defaultPort: 4000 })
  return newWebSocketRpcSession<AuthPublicApi>(resolved)
}
