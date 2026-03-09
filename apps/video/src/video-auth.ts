import { getLogger } from '@catalyst/telemetry'

const logger = getLogger('video-auth')

interface NodeContext {
  nodeId: string
  domains: string[]
}

interface AuthorizeActionRequest {
  action: string
  nodeContext: NodeContext
}

interface AuthorizeActionAllowed {
  success: true
  allowed: boolean
}

interface AuthorizeActionDenied {
  success: false
  errorType: string
  reason?: string
  reasons?: string[]
}

type AuthorizeActionResult = AuthorizeActionAllowed | AuthorizeActionDenied

interface PermissionsHandlers {
  authorizeAction(request: AuthorizeActionRequest): PromiseLike<AuthorizeActionResult>
}

interface AuthClient {
  permissions(token: string): PromiseLike<PermissionsHandlers | { error: string }>
}

export interface VideoAuthRequest {
  token: string
  action: string
  nodeContext: NodeContext
  resource?: {
    routeName: string
    protocol: string
  }
}

export type VideoAuthResult = AuthorizeActionResult

export interface VideoAuthService {
  evaluate(request: VideoAuthRequest): Promise<VideoAuthResult>
}

interface CreateVideoAuthOptions {
  authClient?: AuthClient
}

export function createVideoAuthService(options: CreateVideoAuthOptions): VideoAuthService {
  const { authClient } = options

  return {
    async evaluate(request: VideoAuthRequest): Promise<VideoAuthResult> {
      if (!authClient) {
        logger.warn`Denying ${request.action}: auth service not configured`
        return {
          success: false,
          errorType: 'auth_unavailable',
          reason: 'Auth not configured',
        }
      }

      try {
        const permissionsApi = await authClient.permissions(request.token)
        if ('error' in permissionsApi) {
          return {
            success: false,
            errorType: 'invalid_token',
            reason: permissionsApi.error,
          }
        }

        const result = await permissionsApi.authorizeAction({
          action: request.action,
          nodeContext: request.nodeContext,
        })

        return result
      } catch (error) {
        logger.error`Authorization failed for ${request.action}: ${error}`
        return {
          success: false,
          errorType: 'auth_unavailable',
          reason: 'Authorization failed',
        }
      }
    },
  }
}
