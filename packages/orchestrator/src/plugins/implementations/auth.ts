import { BasePlugin } from '../base.js';
import type { PluginContext, PluginResult, AuthContext } from '../types.js';
import type { IAuthClient } from '../../clients/auth.js';

export interface AuthPluginOptions {
    /** Expected audience claim - if set, tokens must have this audience */
    audience?: string;
}

export class AuthPlugin extends BasePlugin {
    name = 'AuthPlugin';

    constructor(
        private authClient: IAuthClient,
        private options: AuthPluginOptions = {}
    ) {
        super();
    }

    async apply(context: PluginContext): Promise<PluginResult> {
        // Runtime check for authToken - kept local until pattern solidifies
        const authToken = (context as Record<string, unknown>).authToken as string | undefined;

        // No token = deny access
        if (!authToken) {
            return {
                success: false,
                error: {
                    pluginName: this.name,
                    message: 'Authentication token required',
                }
            };
        }

        try {
            const result = await this.authClient.verifyToken(authToken, this.options.audience);

            if (!result.valid) {
                return {
                    success: false,
                    error: {
                        pluginName: this.name,
                        message: 'Invalid authentication token',
                    }
                };
            }

            // Extract auth context from JWT payload
            const extractedAuth = this.extractAuthContext(result.payload);

            // Require subject claim - a token without identity is useless
            if (!extractedAuth.userId) {
                return {
                    success: false,
                    error: {
                        pluginName: this.name,
                        message: 'Token missing subject claim',
                    }
                };
            }

            return {
                success: true,
                ctx: {
                    ...context,
                    // Merge with existing context instead of overwriting
                    authxContext: { ...context.authxContext, ...extractedAuth },
                }
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Authentication failed';
            return {
                success: false,
                error: {
                    pluginName: this.name,
                    message,
                    error,
                }
            };
        }
    }

    /**
     * Extract AuthContext from JWT payload
     *
     * Maps standard JWT claims to our internal auth context:
     * - sub -> userId
     * - orgId -> orgId (custom claim)
     * - role/roles -> roles (normalize to array)
     */
    private extractAuthContext(payload: Record<string, unknown>): AuthContext {
        const authContext: AuthContext = {};

        // User ID from subject claim
        if (typeof payload.sub === 'string') {
            authContext.userId = payload.sub;
        }

        // Organization ID (custom claim)
        if (typeof payload.orgId === 'string') {
            authContext.orgId = payload.orgId;
        }

        // Roles - handle both single role and array of roles
        if (Array.isArray(payload.roles)) {
            // Reject malformed roles - all elements must be strings
            if (!payload.roles.every((r): r is string => typeof r === 'string')) {
                throw new Error('Malformed roles claim: all roles must be strings');
            }
            authContext.roles = payload.roles;
        } else if (typeof payload.role === 'string') {
            authContext.roles = [payload.role];
        }

        return authContext;
    }
}
